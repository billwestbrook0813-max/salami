// server.js — Consistent projections + projected finish
import express from "express";
import { fetch } from "undici";
const app = express();
const PORT = process.env.PORT || 3000;
const TZ = "America/Los_Angeles";
const PROJ_TTL_MS = 10 * 60 * 1000;
const WINDOW_START_PT = 9;
const WINDOW_END_PT   = 21;
const LIVE_RECENT_MIN = 15;
const JUICE_TO_RUNS   = 0.60;
const fmtPT = (opts) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, ...opts });
const todayPT = () => fmtPT({ year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const hourPT = () => Number(fmtPT({ hour: "2-digit", hour12: false }).format(new Date()));
const inWindow = (h = hourPT()) => h >= WINDOW_START_PT && h < WINDOW_END_PT;
const samePTDay = (iso) => fmtPT({ year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) === todayPT();
const recent = (iso) => { if (!iso) return false; const ageMin = (Date.now() - new Date(iso).getTime()) / 60000; return ageMin <= LIVE_RECENT_MIN; };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std  = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function americanToProb(american) { if (american == null) return null; const a = Number(american); if (Number.isNaN(a)) return null; return a < 0 ? (-a) / ((-a) + 100) : 100 / (a + 100); }
function devigTwoWay(pOverRaw, pUnderRaw) { if (pOverRaw == null || pUnderRaw == null) return null; const sum = pOverRaw + pUnderRaw; if (sum <= 0) return null; return { pOver: pOverRaw / sum, pUnder: pUnderRaw / sum }; }
const norm = (s) => (s||"").toLowerCase().replace(/[^a-z]/g,"");
app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/total-runs", async (req, res) => {
  const date = req.query.date || todayPT();
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "SalamiSlider/1.2" } });
    if (!r.ok) throw new Error(`MLB upstream ${r.status}`);
    const data = await r.json();
    const games = data?.dates?.[0]?.games ?? [];
    let totalRuns = 0;
    for (const g of games) {
      const ls = g.linescore;
      totalRuns += (ls?.teams?.away?.runs ?? 0) + (ls?.teams?.home?.runs ?? 0);
    }
    res.json({ date, gamesCount: games.length, totalRuns, lastUpdateUtc: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: String(e) }); }
});
let projCache = { ts: 0, payload: null };
app.get("/api/projected-runs", async (_req, res) => {
  const now = Date.now();
  if (projCache.payload && now - projCache.ts < PROJ_TTL_MS) return res.json(projCache.payload);
  if (!inWindow()) { if (projCache.payload) return res.json(projCache.payload); return res.json({ error: "Projection updates only between 09:00–21:00 PT" }); }
  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_API_KEY) return res.status(500).json({ error: "Missing ODDS_API_KEY" });
  const oddsUrl = new URL("https://api.the-odds-api.com/v4/sports/baseball_mlb/odds");
  oddsUrl.searchParams.set("regions", "us"); oddsUrl.searchParams.set("markets", "totals");
  oddsUrl.searchParams.set("oddsFormat", "american"); oddsUrl.searchParams.set("dateFormat", "iso");
  oddsUrl.searchParams.set("apiKey", ODDS_API_KEY);
  const mlbUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${todayPT()}&hydrate=linescore,team,game,flags,status`;
  try {
    const [oddsResp, mlbResp] = await Promise.all([
      fetch(oddsUrl, { headers: { "User-Agent": "SalamiSlider/1.2" } }),
      fetch(mlbUrl,  { headers: { "User-Agent": "SalamiSlider/1.2" } }),
    ]);
    if (!oddsResp.ok) throw new Error(`Odds API ${oddsResp.status}`);
    if (!mlbResp.ok) throw new Error(`MLB upstream ${mlbResp.status}`);
    const events = await oddsResp.json();
    const mlb = await mlbResp.json();
    const mlbGames = (mlb?.dates?.[0]?.games ?? []).map(g => ({
      id: g.gamePk, home: g.teams?.home?.team?.name, away: g.teams?.away?.team?.name,
      homeAbb: g.teams?.home?.team?.abbreviation, awayAbb: g.teams?.away?.team?.abbreviation,
      state: g.status?.abstractGameState, runsNow: (g.linescore?.teams?.home?.runs ?? 0) + (g.linescore?.teams?.away?.runs ?? 0),
    }));
    const findMlb = (ev) => {
      const h = norm(ev.home_team), a = norm(ev.away_team);
      return mlbGames.find(g => (norm(g.home)+norm(g.homeAbb)).includes(h.slice(0,6)) &&
                                 (norm(g.away)+norm(g.awayAbb)).includes(a.slice(0,6))) || null;
    };
    const games = []; const today = todayPT();
    for (const ev of events) {
      if (!samePTDay(ev.commence_time)) continue;
      const started = new Date(ev.commence_time).getTime() <= Date.now();
      const allPts = [], allAdjPts = [], livePts = [], liveAdjPts = [];
      for (const bk of ev.bookmakers ?? []) {
        const m = (bk.markets ?? []).find(x => x.key === "totals"); if (!m) continue;
        const over  = (m.outcomes ?? []).find(o => /over/i.test(o.name));
        const under = (m.outcomes ?? []).find(o => /under/i.test(o.name));
        const pt = over?.point ?? under?.point; if (typeof pt !== "number") continue;
        const pOverRaw  = americanToProb(over?.price);
        const pUnderRaw = americanToProb(under?.price);
        const dv = devigTwoWay(pOverRaw, pUnderRaw);
        const skew = dv ? (dv.pOver - 0.5) : 0;
        const adjPoint = pt + skew * JUICE_TO_RUNS;
        allPts.push(pt); allAdjPts.push(adjPoint);
        if (started) { const lastUpd = m.last_update || bk.last_update || null; if (recent(lastUpd)) { livePts.push(pt); liveAdjPts.push(adjPoint); } }
      }
      const usedRaw = (started && livePts.length) ? livePts : allPts;
      const usedAdj = (started && liveAdjPts.length) ? liveAdjPts : allAdjPts;
      if (!usedRaw.length) continue;
      const mlbMatch = findMlb(ev);
      const runsNow = mlbMatch?.runsNow ?? 0;
      const mlbState = mlbMatch?.state ?? (started ? "Live" : "Preview");
      const adjMean = Number(mean(usedAdj).toFixed(2));
      const remain = adjMean - runsNow;
      games.push({
        id: ev.id, status: mlbState, commence_time: ev.commence_time,
        home_team: ev.home_team, away_team: ev.away_team, bookmakers_count: usedRaw.length,
        consensus_total: Number(mean(usedRaw).toFixed(2)),
        consensus_total_adj: adjMean, consensus_std: Number(std(usedRaw).toFixed(2)),
        current_runs: runsNow, expected_remaining_raw: Number(remain.toFixed(2)),
        expected_remaining: Number(Math.max(0, remain).toFixed(2))
      });
    }
    const sumAdjAll = Number(games.reduce((s,g)=> s + (g.consensus_total_adj ?? g.consensus_total), 0).toFixed(2));
    const projectedRuns = Number(sumAdjAll.toFixed(1));
    const actualRunsToday = mlbGames.reduce((s, g) => s + (g.runsNow || 0), 0);
    const remainingExpected = Number(
      games.filter(g => g.status !== "Final").reduce((s,g)=> s + (g.expected_remaining || 0), 0).toFixed(2)
    );
    const projectedFinish = Number((actualRunsToday + remainingExpected).toFixed(2));
    const projectedStd  = Number(Math.sqrt(games.reduce((s, g) => s + (g.consensus_std ** 2 || 0), 0)).toFixed(1));
    const bandLow  = Number((projectedRuns - projectedStd).toFixed(1));
    const bandHigh = Number((projectedRuns + projectedStd).toFixed(1));
    const payload = {
      datePT: today, projectedRuns_raw: projectedRuns, projectedRuns,
      projectedStd, bandLow, bandHigh, gameCountUsed: games.length, games,
      actualRunsToday, remainingExpected, projectedFinish,
      source: "The Odds API + MLB Stats API (live-aware, juice-adjusted)",
      lastUpdateUtc: new Date().toISOString(),
      diag: { sumAdjAll: projectedRuns, gamesPreview: games.filter(g=>g.status==='Preview').length, gamesLive: games.filter(g=>g.status==='Live').length, gamesFinal: games.filter(g=>g.status==='Final').length },
      config: { windowStartPT: WINDOW_START_PT, windowEndPT: WINDOW_END_PT, cacheMinutes: PROJ_TTL_MS/60000, liveRecentMinutes: LIVE_RECENT_MIN, juiceToRuns: JUICE_TO_RUNS }
    };
    projCache = { ts: now, payload };
    res.json(payload);
  } catch (e) { res.status(502).json({ error: String(e) }); }
});
app.get("/api/scoreboard", async (req, res) => {
  const date = req.query.date || todayPT();
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team,game,flags,status`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "SalamiSlider/1.2" } });
    if (!r.ok) throw new Error(`MLB upstream ${r.status}`);
    const data = await r.json();
    const games = data?.dates?.[0]?.games ?? [];
    const items = games.map((g) => {
      const home = g.teams?.home?.team?.abbreviation || g.teams?.home?.team?.name || "HOME";
      const away = g.teams?.away?.team?.abbreviation || g.teams?.away?.team?.name || "AWAY";
      const hs = g.linescore?.teams?.home?.runs ?? 0;
      const as = g.linescore?.teams?.away?.runs ?? 0;
      const state = g.status?.abstractGameState;
      const detailed = g.status?.detailedState;
      let tag = "";
      if (state === "Preview") tag = "Scheduled";
      else if (state === "Live") { const inning = g.linescore?.currentInning; const half = g.linescore?.isTopInning ? "Top" : "Bot"; const outs = g.linescore?.outs ?? 0; tag = `${half} ${inning}, ${outs} out${outs === 1 ? "" : "s"}`; }
      else if (state === "Final") { const ord = g.linescore?.currentInningOrdinal || "F"; tag = ord; }
      else tag = detailed || state || "";
      return { id: g.gamePk, away, as, home, hs, state, tag };
    });
    const ord = (s) => (s === "Live" ? 0 : s === "Preview" ? 1 : 2);
    items.sort((a, b) => ord(a.state) - ord(b.state));
    res.json({ date, items, lastUpdateUtc: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: String(e) }); }
});
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
