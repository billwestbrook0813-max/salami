const $ = (s)=>document.querySelector(s);
const fmt = (n)=> (typeof n==="number"? n.toLocaleString("en-US",{maximumFractionDigits:1}) : n);

async function fetchJSON(url){
  const r = await fetch(url, { cache:"no-store" });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

function renderTotals(d){
  $("#projectedRuns").textContent = fmt(d.projectedRuns);
  $("#projectedFinish").textContent = fmt(d.projectedFinish);
  $("#actualRunsToday").textContent = fmt(d.actualRunsToday);
  $("#remainingExpected").textContent = fmt(d.remainingExpected);
  $("#gamesUsed").textContent = `${d.gameCountUsed||0} games used`;
  $("#datePT").textContent = d.datePT || "--";
  $("#lastUpdate").textContent = new Date(d.lastUpdateUtc||Date.now()).toLocaleTimeString();

  const low = d.bandLow ?? 0, high = d.bandHigh ?? 0;
  const span = Math.max(1, high-low);
  const pos = Math.min(100, Math.max(0, ((d.projectedRuns - low)/span)*100));
  document.getElementById("bandFill").style.width = pos + "%";

  const ti = document.getElementById("tickerInner");
  ti.innerHTML = (d.games||[]).map(g=>{
    const st = g.status || "Preview";
    const cls = `ticker__state ticker__state--${st}`;
    return `<div class="ticker__item"><span class="${cls}">${st}</span><b>${g.away_team}</b> @ <b>${g.home_team}</b><span>${fmt(g.current_runs)} runs</span><span>exp rem ${fmt(g.expected_remaining)}</span></div>`;
  }).concat(d.games||[]).join(" • ");
}

function renderScoreboard(board){
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  grid.innerHTML = "";
  if(!board.items || board.items.length===0){ empty.hidden=false; return; }
  empty.hidden=true;
  for(const it of board.items){
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card__head">
        <div class="v-team"><span>${it.away}</span> @ <span>${it.home}</span></div>
        <div class="v-score">${it.as}–${it.hs}</div>
      </div>
      <div class="card__body">
        <div class="badge">${it.tag || it.state}</div>
        <div class="state state--${it.state || ""}">${it.state}</div>
      </div>
    `;
    grid.appendChild(card);
  }
}

async function pull(){
  try{
    const [proj, board] = await Promise.all([
      fetchJSON("/api/projected-runs").catch(_=>({ projectedRuns:0, projectedFinish:0, actualRunsToday:0, remainingExpected:0, gameCountUsed:0, games:[], datePT:"--", bandLow:0, bandHigh:0 })),
      fetchJSON("/api/scoreboard").catch(_=>({items:[], date:"--"}))
    ]);
    renderTotals(proj);
    renderScoreboard(board);
  }catch(e){ console.error(e); }
}

pull();
setInterval(pull, 30000);
