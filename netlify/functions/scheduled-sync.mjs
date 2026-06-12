// netlify/functions/scheduled-sync.mjs
// Scheduled function: runs every hour, fetches the latest match data from
// football-data.org (free tier), applies it to the shared state in Netlify Blobs.
//
// Required env vars: FOOTBALL_DATA_KEY, BLOBS_SITE_ID, BLOBS_TOKEN
//
// Trigger manually at: /.netlify/functions/scheduled-sync

import { getStore } from "@netlify/blobs";

/* ============================================================
   FIXTURE DATA — mirrors the client's buildFixtures exactly
   ============================================================ */
const GROUPS = {
  A:["Mexico","South Africa","South Korea","Czechia"],
  B:["Canada","Bosnia & Herzegovina","Qatar","Switzerland"],
  C:["Brazil","Morocco","Haiti","Scotland"],
  D:["United States","Paraguay","Australia","Türkiye"],
  E:["Germany","Curaçao","Côte d'Ivoire","Ecuador"],
  F:["Netherlands","Japan","Sweden","Tunisia"],
  G:["Belgium","Egypt","Iran","New Zealand"],
  H:["Spain","Cape Verde","Saudi Arabia","Uruguay"],
  I:["France","Senegal","Iraq","Norway"],
  J:["Argentina","Algeria","Austria","Jordan"],
  K:["Portugal","DR Congo","Uzbekistan","Colombia"],
  L:["England","Croatia","Ghana","Panama"]
};
const GROUP_DATES = {
  A:[11,18,24], B:[12,18,24], C:[13,19,24], D:[12,19,25],
  E:[14,20,25], F:[14,20,25], G:[15,21,26], H:[15,21,26],
  I:[16,21,26], J:[16,22,27], K:[17,22,27], L:[17,22,27]
};
function pad(n){ return String(n).padStart(2,"0"); }
function buildFixtures(){
  const fx=[]; let id=1;
  const RR=[ [[0,1],[2,3]], [[0,2],[3,1]], [[0,3],[1,2]] ];
  Object.keys(GROUPS).forEach(g=>{
    const t=GROUPS[g];
    RR.forEach((pairs,md)=>{
      const day=GROUP_DATES[g][md];
      pairs.forEach(([a,b])=>{
        fx.push({id:id++,stage:"Group "+g,group:g,matchday:md+1,
                 date:`2026-06-${pad(day)}`,home:t[a],away:t[b]});
      });
    });
  });
  const ko=[
    ["Round of 32",[[6,28],[6,28],[6,29],[6,29],[6,29],[6,30],[6,30],[6,30],
                    [7,1],[7,1],[7,1],[7,2],[7,2],[7,3],[7,3],[7,3]]],
    ["Round of 16",[[7,4],[7,4],[7,5],[7,5],[7,6],[7,6],[7,7],[7,7]]],
    ["Quarter-final",[[7,9],[7,9],[7,11],[7,11]]],
    ["Semi-final",[[7,14],[7,15]]],
    ["Third place",[[7,18]]],
    ["Final",[[7,19]]]
  ];
  ko.forEach(([stage,dates])=>dates.forEach(([m,d])=>{
    fx.push({id:id++,stage,group:null,matchday:null,
             date:`2026-${pad(m)}-${pad(d)}`,home:"TBD",away:"TBD",ko:true});
  }));
  return fx;
}

/* ============================================================
   SYNC LOGIC — mirrors the client's applySync exactly
   ============================================================ */
const ALIASES = {
  'korearepublic':'southkorea','republicofkorea':'southkorea','korea':'southkorea',
  'czechrepublic':'czechia',
  'turkey':'turkiye',
  'caboverde':'capeverde',
  'congodr':'drcongo','democraticrepublicofthecongo':'drcongo',
  'usa':'unitedstates','unitedstatesofamerica':'unitedstates',
  'ivorycoast':'cotedivoire',
  'bosniaandherzegovina':'bosniaherzegovina',
  'iranislamicrepublic':'iran','islamicrepublicofiran':'iran','iriran':'iran'
};
const STAGE_MAP = {
  'round of 32':'Round of 32',
  'round of 16':'Round of 16',
  'quarter-finals':'Quarter-final','quarter-final':'Quarter-final','quarter finals':'Quarter-final',
  'semi-finals':'Semi-final','semi-final':'Semi-final','semi finals':'Semi-final',
  'final':'Final',
  '3rd-place final':'Third place','3rd place final':'Third place','third place':'Third place','play-off for third place':'Third place'
};
function norm(s){
  const base = (s||"").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z]/g,"");
  return ALIASES[base] || base;
}
const STOP_TOKENS = new Set(['jr','jnr','snr','iii','junior','senior']);
function tokenize(n){
  return (n||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z\s\-.]/g,' ')
    .split(/[\s\-.]+/)
    .filter(t => t && !STOP_TOKENS.has(t));
}
function namesMatch(a, b){
  const na = norm(a), nb = norm(b);
  if(!na || !nb) return false;
  if(na === nb) return true;
  if(na.length >= 4 && nb.includes(na)) return true;
  if(nb.length >= 4 && na.includes(nb)) return true;
  const ta = tokenize(a), tb = tokenize(b);
  if(!ta.length || !tb.length) return false;
  const meanA = ta.filter(t => t.length >= 2);
  const meanB = tb.filter(t => t.length >= 2);
  if(!meanA.length || !meanB.length) return false;
  const tokenOK = (t1, t2) =>
    t1 === t2 || (t1.length >= 4 && t2.length >= 4 && (t1.startsWith(t2) || t2.startsWith(t1)));
  const shorter = meanA.length <= meanB.length ? meanA : meanB;
  const longer  = meanA.length <= meanB.length ? meanB : meanA;
  if(shorter.length >= 2 && shorter.every(t1 => longer.some(t2 => tokenOK(t1, t2)))) return true;
  let mt = null;
  for(const t1 of meanA){ for(const t2 of meanB){ if(tokenOK(t1, t2)){mt=t1; break;} } if(mt) break; }
  if(!mt) return false;
  const sA = meanA[meanA.length-1], sB = meanB[meanB.length-1];
  const isSurname = mt===sA || mt===sB ||
    (mt.length >= 4 && sA.length >= 4 && (mt.startsWith(sA) || sA.startsWith(mt))) ||
    (mt.length >= 4 && sB.length >= 4 && (mt.startsWith(sB) || sB.startsWith(mt)));
  if(!isSurname) return false;
  const fA = (ta[0] === mt && ta.length > 1) ? ta[1] : ta[0];
  const fB = (tb[0] === mt && tb.length > 1) ? tb[1] : tb[0];
  if(fA && fB && fA !== mt && fB !== mt){ if(fA[0] !== fB[0]) return false; }
  return true;
}
function fxTeams(f, state){
  const r = state.results[f.id] || {};
  return {
    home: f.ko ? (r.koHome || f.home) : f.home,
    away: f.ko ? (r.koAway || f.away) : f.away
  };
}
function applySync(data, state, FIXTURES){
  if(!Array.isArray(data)) return {updated:0,koFilled:0,timesUpdated:0};
  state.results = state.results || {};
  state.times   = state.times   || {};
  state.players = state.players || [];

  // 1) Bracket resolution
  const apiByStage = {};
  data.forEach(m => {
    const stage = STAGE_MAP[(m.stage||"").toLowerCase().trim()];
    if(!stage) return;
    (apiByStage[stage] = apiByStage[stage] || []).push(m);
  });
  let koFilled = 0;
  Object.keys(apiByStage).forEach(stage => {
    const apiList = apiByStage[stage].slice().sort((a,b) => new Date(a.date) - new Date(b.date));
    const localList = FIXTURES.filter(f => f.ko && f.stage === stage)
      .sort((a,b) => (a.date<b.date?-1:a.date>b.date?1:0) || (a.id - b.id));
    apiList.forEach((m,i) => {
      const local = localList[i];
      if(!local) return;
      const r = state.results[local.id] = state.results[local.id] || {};
      if(!r.koHome && !r.koAway){ r.koHome = m.home; r.koAway = m.away; koFilled++; }
      if(m.date) state.times[local.id] = m.date;
    });
  });

  // 2) Update kickoff times
  let timesUpdated = 0;
  data.forEach(m => {
    if(!m.date) return;
    const fx = FIXTURES.find(f => {
      const {home,away} = fxTeams(f, state);
      return (norm(home)===norm(m.home) && norm(away)===norm(m.away)) ||
             (norm(home)===norm(m.away) && norm(away)===norm(m.home));
    });
    if(!fx) return;
    if(state.times[fx.id] !== m.date){ state.times[fx.id] = m.date; timesUpdated++; }
  });

  // 3) Finished match results
  let updated = 0;
  data.forEach(m => {
    if(!m.finished || m.homeScore==null) return;
    const fx = FIXTURES.find(f => {
      const {home,away} = fxTeams(f, state);
      return (norm(home)===norm(m.home) && norm(away)===norm(m.away)) ||
             (norm(home)===norm(m.away) && norm(away)===norm(m.home));
    });
    if(!fx) return;
    const {home} = fxTeams(fx, state);
    const swap = norm(home) !== norm(m.home);
    const r = state.results[fx.id] = state.results[fx.id] || {goals:{}};
    r.hs = swap ? m.awayScore : m.homeScore;
    r.as = swap ? m.homeScore : m.awayScore;
    r.winner = r.hs>r.as ? 'home' : r.as>r.hs ? 'away' :
      (m.penWinner ? (norm(m.penWinner)===norm(fxTeams(fx,state).home) ? 'home' : 'away') : 'draw');
    if(Array.isArray(m.scorers)){
      r.goals = r.goals || {};
      m.scorers.forEach(sc => {
        const p = state.players.find(pl => namesMatch(pl.name, sc.name));
        if(p) r.goals[p.id] = sc.count || 1;
      });
    }
    updated++;
  });

  return {updated, koFilled, timesUpdated};
}

/* ============================================================
   football-data.org fetch
   ============================================================ */
const STAGE_LABELS = {
  GROUP_STAGE:    "Group Stage",
  ROUND_OF_32:    "Round of 32",
  LAST_16:        "Round of 16",
  ROUND_OF_16:    "Round of 16",
  QUARTER_FINALS: "Quarter-finals",
  SEMI_FINALS:    "Semi-finals",
  THIRD_PLACE:    "Third place",
  FINAL:          "Final",
};

async function fetchApiData(key){
  const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
    headers: { "X-Auth-Token": key }
  });
  if(!res.ok) throw new Error(`football-data.org API error ${res.status}`);
  const data = await res.json();
  const matches = data.matches || [];

  return matches
    .filter(m => m.homeTeam?.name && m.awayTeam?.name)
    .map(m => {
      const finished = m.status === "FINISHED";
      const ft = m.score?.fullTime;
      const hasPens = m.score?.penalties?.home != null;
      let penWinner = null;
      if(hasPens){
        if(m.score.winner === "HOME_TEAM") penWinner = m.homeTeam.name;
        else if(m.score.winner === "AWAY_TEAM") penWinner = m.awayTeam.name;
      }
      const scorerMap = {};
      (m.goals || []).forEach(g => {
        if(g.type === "OWN" || !g.scorer?.name) return;
        scorerMap[g.scorer.name] = (scorerMap[g.scorer.name] || 0) + 1;
      });
      const scorers = Object.entries(scorerMap).map(([name, count]) => ({ name, team: "", count }));
      return {
        home: m.homeTeam.name,
        away: m.awayTeam.name,
        homeScore: finished && ft ? ft.home : null,
        awayScore: finished && ft ? ft.away : null,
        finished,
        stage: STAGE_LABELS[m.stage] || m.stage || "",
        date: m.utcDate,
        penWinner,
        scorers,
      };
    });
}

/* ============================================================
   MAIN HANDLER
   ============================================================ */
export default async () => {
  const apiKey = process.env.FOOTBALL_DATA_KEY;  // <-- updated from APIFOOTBALL_KEY
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;

  if(!apiKey)  return Response.json({error:"FOOTBALL_DATA_KEY not set"}, {status:500});
  if(!siteID || !token) return Response.json({error:"BLOBS_SITE_ID / BLOBS_TOKEN not set"}, {status:500});

  try {
    const store = getStore({ name: "go3-state", siteID, token });
    const stateText = await store.get("state");
    if(!stateText) return Response.json({ok:false, reason:"no state in Blobs yet"});
    const state = JSON.parse(stateText);

    const apiData = await fetchApiData(apiKey);
    const FIXTURES = buildFixtures();
    const result = applySync(apiData, state, FIXTURES);

    state._lastAutoSync = new Date().toISOString();
    await store.set("state", JSON.stringify(state));

    return Response.json({
      ok: true,
      ranAt: state._lastAutoSync,
      apiMatchesReceived: apiData.length,
      ...result
    });
  } catch(e) {
    return Response.json({ ok:false, error: String(e) }, { status: 500 });
  }
};

export const config = { schedule: "@hourly" };
