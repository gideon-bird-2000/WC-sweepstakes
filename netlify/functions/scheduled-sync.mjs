// netlify/functions/scheduled-sync.mjs
// Scheduled function: runs every 5 minutes, fetches latest match data from
// worldcup26.ir (free, no API key, includes scorers) and applies it to shared state.
//
// Required env vars: BLOBS_SITE_ID, BLOBS_TOKEN
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
const ALL_TEAMS = Object.values(GROUPS).flat();
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
const STOP_TOKENS = new Set(['jr','jnr','snr','iii']);
function tokenize(n){
  return (n||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z\s\-.]/g,' ')
    .split(/[\s\-.]+/)
    .filter(t => t && !STOP_TOKENS.has(t));
}
function getAbbreviatedForm(raw){
  const cleaned = (raw||'').replace(/\./g,'. ').replace(/\s+/g,' ').trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if(tokens.length<2) return null;
  const initials=[];
  for(let i=0;i<tokens.length-1;i++){
    const t=tokens[i].replace(/\./g,'');
    if(t.length!==1) return null;
    initials.push(t.toLowerCase());
  }
  const surname=tokens[tokens.length-1].toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z]/g,'');
  if(!surname || surname.length<2) return null;
  return {initials,surname};
}
function namesMatch(a, b){
  const na = norm(a), nb = norm(b);
  if(!na || !nb) return false;
  if(na === nb) return true;
  const ta = tokenize(a).filter(t => t.length >= 2);
  const tb = tokenize(b).filter(t => t.length >= 2);
  if(!ta.length || !tb.length) return false;
  // Abbreviated form match: "V. Júnior" vs "Vinícius Júnior"
  const tryAbbrev = (abbrev, fullTokens) => {
    if(!abbrev) return false;
    const surname=fullTokens[fullTokens.length-1];
    const firstInitial=fullTokens[0][0];
    const surnameOK = surname===abbrev.surname ||
      (surname.length>=4 && abbrev.surname.length>=4 &&
       (surname.startsWith(abbrev.surname)||abbrev.surname.startsWith(surname)));
    if(!surnameOK) return false;
    return abbrev.initials[0]===firstInitial;
  };
  if(tryAbbrev(getAbbreviatedForm(a), tb)) return true;
  if(tryAbbrev(getAbbreviatedForm(b), ta)) return true;
  if(na.length >= 4 && nb.includes(na)) return true;
  if(nb.length >= 4 && na.includes(nb)) return true;
  const tokenOK = (t1, t2) =>
    t1 === t2 || (t1.length >= 4 && t2.length >= 4 && (t1.startsWith(t2) || t2.startsWith(t1)));
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer  = ta.length <= tb.length ? tb : ta;
  if(shorter.length >= 2 && shorter.every(t1 => longer.some(t2 => tokenOK(t1, t2)))) return true;
  let mt = null;
  for(const t1 of ta){ for(const t2 of tb){ if(tokenOK(t1, t2)){mt=t1; break;} } if(mt) break; }
  if(!mt) return false;
  const sA = ta[ta.length-1], sB = tb[tb.length-1];
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
  // A bracket slot is "placeholder" if it contains words like "Winner"/"Runner-up"/"Loser"/"Group" or starts with "Match"
  const isPlaceholderName = s => !s || /\b(winner|runner-?up|loser|group|3rd)\b/i.test(s) || /^match\s/i.test(s);
  // Map API team name to local name (e.g. "Ivory Coast" → "Côte d'Ivoire")
  const _lnc = {};
  const toLocalName = apiName => {
    if(!apiName) return apiName;
    if(_lnc[apiName]) return _lnc[apiName];
    const n = norm(apiName);
    const match = ALL_TEAMS.find(t => norm(t) === n);
    _lnc[apiName] = match || apiName;
    return _lnc[apiName];
  };
  // Fix any previously-stored API names in KO slots
  FIXTURES.filter(f => f.ko).forEach(f => {
    const r = state.results[f.id];
    if(!r) return;
    if(r.koHome && !isPlaceholderName(r.koHome)) r.koHome = toLocalName(r.koHome);
    if(r.koAway && !isPlaceholderName(r.koAway)) r.koAway = toLocalName(r.koAway);
  });
  Object.keys(apiByStage).forEach(stage => {
    const apiList = apiByStage[stage].slice().sort((a,b) => new Date(a.date) - new Date(b.date));
    const localList = FIXTURES.filter(f => f.ko && f.stage === stage)
      .sort((a,b) => (a.date<b.date?-1:a.date>b.date?1:0) || (a.id - b.id));
    apiList.forEach((m,i) => {
      const local = localList[i];
      if(!local) return;
      const r = state.results[local.id] = state.results[local.id] || {};
      const apiHasRealNames = !isPlaceholderName(m.home) && !isPlaceholderName(m.away);
      const slotIsPlaceholder = isPlaceholderName(r.koHome) && isPlaceholderName(r.koAway);
      if(apiHasRealNames && slotIsPlaceholder){ r.koHome = toLocalName(m.home); r.koAway = toLocalName(m.away); koFilled++; }
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
    if(m.penWinner && r.hs===r.as){
      r.pen = norm(m.penWinner)===norm(fxTeams(fx,state).home) ? 'home' : 'away';
    }
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
   worldcup26.ir fetch — free, no API key, includes scorers
   ============================================================ */
const WC26_STAGE_MAP = {
  R32:"Round of 32", R16:"Round of 16", QF:"Quarter-final",
  SF:"Semi-final", "3RD":"Third place", FINAL:"Final"
};

function wc26ParseScorers(raw){
  if(!raw || raw==="null" || raw===null) return [];
  let s = String(raw).trim().replace(/^\{/,"").replace(/\}$/,"");
  s = s.replace(/[\u201C\u201D\u2018\u2019]/g,'"');
  const parts = s.split(/"\s*,\s*"/).map(p => p.replace(/^"|"$/g,"").trim()).filter(Boolean);
  return parts.map(p => {
    const isOG = /\(OG\)/i.test(p);
    const name = p.replace(/\s*\d+'?(\+\d*'?)?\s*(\(OG\)|\(p\))?\s*$/i,"").trim();
    return {name,isOG};
  });
}
function wc26AggregateScorers(parsed){
  const counts = {};
  parsed.forEach(p => {
    if(p.isOG || !p.name) return;
    counts[p.name] = (counts[p.name]||0) + 1;
  });
  return Object.entries(counts).map(([name,count]) => ({name,team:"",count}));
}

async function fetchApiData(){
  const res = await fetch("https://worldcup26.ir/get/games", {
    headers: {"Accept":"application/json"}
  });
  if(!res.ok) throw new Error(`worldcup26.ir API error ${res.status}`);
  const data = await res.json();
  const games = Array.isArray(data.games) ? data.games : [];

  return games.map(g => {
    const finished = String(g.finished).toUpperCase() === "TRUE";
    const home = g.home_team_name_en || g.home_team_label || "";
    const away = g.away_team_name_en || g.away_team_label || "";

    let stage = "";
    if(g.type === "group") stage = "Group Stage";
    else if(WC26_STAGE_MAP[g.group]) stage = WC26_STAGE_MAP[g.group];
    else stage = g.group || "";

    const homeScorers = wc26AggregateScorers(wc26ParseScorers(g.home_scorers));
    const awayScorers = wc26AggregateScorers(wc26ParseScorers(g.away_scorers));
    const scorers = [...homeScorers, ...awayScorers];

    let date = null;
    if(g.local_date){
      const m = g.local_date.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
      if(m){ const[,mo,da,yr,hr,mn]=m; date = `${yr}-${mo}-${da}T${hr}:${mn}:00Z`; }
    }

    return {
      home, away,
      homeScore: finished ? parseInt(g.home_score,10) : null,
      awayScore: finished ? parseInt(g.away_score,10) : null,
      finished,
      stage,
      date,
      penWinner: null,
      scorers,
    };
  });

  // Infer penalty winners for drawn KO matches
  const KO_STAGES = ["Round of 32","Round of 16","Quarter-final","Semi-final","Final","Third place"];
  const nextStage = { "Round of 32":"Round of 16", "Round of 16":"Quarter-final", "Quarter-final":"Semi-final", "Semi-final":"Final" };
  const isPlaceholderLabel = n => !n || /\b(winner|loser|runner|group|3rd|match)\b/i.test(n);

  out.forEach(m => {
    if(!m.finished || m.homeScore==null) return;
    if(!KO_STAGES.includes(m.stage)) return;
    if(m.homeScore !== m.awayScore) return;
    if(isPlaceholderLabel(m.home) || isPlaceholderLabel(m.away)) return;

    const ns = nextStage[m.stage];
    const searchStages = ns ? [ns] : [];
    if(m.stage === "Semi-final") searchStages.push("Third place");

    for(const laterMatch of out){
      if(!searchStages.includes(laterMatch.stage)) continue;
      const lh = (laterMatch.home||"").toLowerCase();
      const la = (laterMatch.away||"").toLowerCase();
      if(isPlaceholderLabel(laterMatch.home) && isPlaceholderLabel(laterMatch.away)) continue;

      const homeInLater = (!isPlaceholderLabel(laterMatch.home) && lh===m.home.toLowerCase()) ||
                          (!isPlaceholderLabel(laterMatch.away) && la===m.home.toLowerCase());
      const awayInLater = (!isPlaceholderLabel(laterMatch.home) && lh===m.away.toLowerCase()) ||
                          (!isPlaceholderLabel(laterMatch.away) && la===m.away.toLowerCase());

      if(homeInLater && !awayInLater){ m.penWinner=m.home; break; }
      if(awayInLater && !homeInLater){ m.penWinner=m.away; break; }
    }
  });

  return out;
}

/* ============================================================
   MAIN HANDLER
   ============================================================ */
export default async () => {
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;
  const siteURL = process.env.URL || 'https://wc-sweepstakes.netlify.app';

  if(!siteID || !token) return Response.json({error:"BLOBS_SITE_ID / BLOBS_TOKEN not set"}, {status:500});

  try {
    const store = getStore({ name: "go3-state", siteID, token });
    const stateText = await store.get("state");
    if(!stateText) return Response.json({ok:false, reason:"no state in Blobs yet"});
    const state = JSON.parse(stateText);

    // Call the wc-results function (single source of truth for API data + penalty inference)
    const apiRes = await fetch(`${siteURL}/.netlify/functions/wc-results`);
    if(!apiRes.ok) throw new Error(`wc-results returned ${apiRes.status}`);
    const apiData = await apiRes.json();
    if(!Array.isArray(apiData)) throw new Error('wc-results did not return an array');

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

export const config = { schedule: "*/5 * * * *" };
