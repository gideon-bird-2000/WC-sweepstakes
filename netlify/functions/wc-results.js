// netlify/functions/wc-results.js
// HYBRID: worldcup26.ir for scores/brackets + API-Football for clean scorer names.
// worldcup26.ir = free, unlimited, but garbles some scorer names via Persian transliteration.
// API-Football = free, 100 req/day, clean English scorer names.
//
// Pass ?scorers=1 to enable API-Football scorer enrichment (server cron only).
// Without it, returns worldcup26.ir data as-is (used by client auto-sync).
//
// ENV VARS: APIFOOTBALL_KEY (optional — if missing, scorer enrichment is skipped)

const WC26_URL = "https://worldcup26.ir/get/games";
const APIFB_URL = "https://v3.football.api-sports.io";

const STAGE_MAP = {
  R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final",
  SF: "Semi-final", "3RD": "Third place", FINAL: "Final",
};

// ---- worldcup26.ir scorer parser ----
function parseScorers(raw) {
  if (!raw || raw === "null" || raw === null) return [];
  let s = String(raw).trim().replace(/^\{/, "").replace(/\}$/, "");
  s = s.replace(/[\u201C\u201D\u2018\u2019]/g, '"');
  const parts = s.split(/"\s*,\s*"/).map(p => p.replace(/^"|"$/g, "").trim()).filter(Boolean);
  return parts.map(p => {
    const isOG = /\(OG\)/i.test(p);
    const name = p.replace(/\s*\d+'?(\+\d*'?)?\s*(\(OG\)|\(p\))?\s*$/i, "").trim();
    return { name, isOG };
  });
}
function aggregateScorers(parsed) {
  const counts = {};
  parsed.forEach(p => { if (p.isOG || !p.name) return; counts[p.name] = (counts[p.name] || 0) + 1; });
  return Object.entries(counts).map(([name, count]) => ({ name, team: "", count }));
}

// ---- Penalty winner inference ----
const KO_STAGES = ["Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Final", "Third place"];
const NEXT_STAGE = { "Round of 32": "Round of 16", "Round of 16": "Quarter-final", "Quarter-final": "Semi-final", "Semi-final": "Final" };
const isPlaceholder = n => !n || /\b(winner|loser|runner|group|3rd|match)\b/i.test(n);

function inferPenaltyWinners(out) {
  out.forEach(m => {
    if (!m.finished || m.homeScore == null) return;
    if (!KO_STAGES.includes(m.stage)) return;
    if (m.homeScore !== m.awayScore) return;
    if (isPlaceholder(m.home) || isPlaceholder(m.away)) return;
    const ns = NEXT_STAGE[m.stage];
    const searchStages = ns ? [ns] : [];
    if (m.stage === "Semi-final") searchStages.push("Third place");
    for (const later of out) {
      if (!searchStages.includes(later.stage)) continue;
      if (isPlaceholder(later.home) && isPlaceholder(later.away)) continue;
      const lh = (later.home || "").toLowerCase(), la = (later.away || "").toLowerCase();
      const homeIn = (!isPlaceholder(later.home) && lh === m.home.toLowerCase()) ||
                     (!isPlaceholder(later.away) && la === m.home.toLowerCase());
      const awayIn = (!isPlaceholder(later.home) && lh === m.away.toLowerCase()) ||
                     (!isPlaceholder(later.away) && la === m.away.toLowerCase());
      if (homeIn && !awayIn) { m.penWinner = m.home; break; }
      if (awayIn && !homeIn) { m.penWinner = m.away; break; }
    }
  });
}

// ---- Fetch worldcup26.ir ----
async function fetchWorldcup26() {
  const res = await fetch(WC26_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`worldcup26.ir error ${res.status}`);
  const data = await res.json();
  const games = Array.isArray(data.games) ? data.games : [];

  return games.map(g => {
    const finished = String(g.finished).toUpperCase() === "TRUE";
    const home = g.home_team_name_en || g.home_team_label || "";
    const away = g.away_team_name_en || g.away_team_label || "";
    let stage = "";
    if (g.type === "group") stage = "Group Stage";
    else if (STAGE_MAP[g.group]) stage = STAGE_MAP[g.group];
    else stage = g.group || "";
    const homeScorers = aggregateScorers(parseScorers(g.home_scorers));
    const awayScorers = aggregateScorers(parseScorers(g.away_scorers));
    let date = null;
    if (g.local_date) {
      const m = g.local_date.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
      if (m) { const [, mo, da, yr, hr, mn] = m; date = `${yr}-${mo}-${da}T${hr}:${mn}:00Z`; }
    }
    return {
      home, away,
      homeScore: finished ? parseInt(g.home_score, 10) : null,
      awayScore: finished ? parseInt(g.away_score, 10) : null,
      finished, stage, date, penWinner: null,
      scorers: [...homeScorers, ...awayScorers],
    };
  });
}

// ---- Enrich scorers from API-Football (clean names) ----
// Fetches last N finished fixtures, pulls events for each, replaces scorer data.
// Budget: 1 fixtures call + MAX_EVENTS event calls per invocation.
const MAX_EVENTS = 3; // 1 + 3 = 4 calls × 24 hours = 96/day (under 100 limit)
const APIFB_FINISHED = ["FT", "AET", "PEN"];

const APIFB_ALIASES = {
  'korearepublic': 'southkorea', 'republicofkorea': 'southkorea',
  'czechrepublic': 'czechia', 'turkey': 'turkiye',
  'caboverde': 'capeverde', 'cotedivoire': 'cotedivoire',
  'usa': 'unitedstates', 'unitedstatesofamerica': 'unitedstates',
  'ivorycoast': 'cotedivoire', 'congodr': 'drcongo',
  'democraticrepublicofthecongo': 'drcongo',
  'bosniaandherzegovina': 'bosniaherzegovina',
  'iranislamicrepublic': 'iran', 'iriran': 'iran',
};
function normName(s) {
  const base = (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
  return APIFB_ALIASES[base] || base;
}

async function enrichScorers(out, apiKey, debug) {
  const log = [];
  if (!apiKey) { log.push("NO APIFOOTBALL_KEY env var"); return log; }
  const headers = { "x-apisports-key": apiKey };

  try {
    // 1. Get recently finished fixtures from API-Football
    log.push("Fetching API-Football fixtures...");
    const fxRes = await fetch(`${APIFB_URL}/fixtures?league=1&season=2026&last=10`, { headers });
    if (!fxRes.ok) { log.push(`API-Football fixtures returned ${fxRes.status}`); return log; }
    const fxData = await fxRes.json();
    const allFx = fxData.response || [];
    log.push(`API-Football returned ${allFx.length} fixtures`);
    if (fxData.errors && Object.keys(fxData.errors).length) log.push(`API errors: ${JSON.stringify(fxData.errors)}`);
    const fixtures = allFx.filter(f => APIFB_FINISHED.includes(f.fixture?.status?.short));
    log.push(`${fixtures.length} are finished (FT/AET/PEN)`);

    // Sort most recent first, cap at MAX_EVENTS
    const recent = fixtures
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, MAX_EVENTS);
    log.push(`Processing ${recent.length} most recent for events`);

    // 2. For each, fetch events and match to our output array
    await Promise.all(recent.map(async apiFx => {
      const fxHome = apiFx.teams?.home?.name || "?";
      const fxAway = apiFx.teams?.away?.name || "?";
      log.push(`Fixture: ${fxHome} vs ${fxAway} (id=${apiFx.fixture.id})`);
      try {
        const evRes = await fetch(`${APIFB_URL}/fixtures/events?fixture=${apiFx.fixture.id}`, { headers });
        if (!evRes.ok) { log.push(`  Events returned ${evRes.status}`); return; }
        const evData = await evRes.json();

        // Build scorer map from events
        const goals = {};
        (evData.response || []).forEach(e => {
          if (e.type === "Goal" && e.detail !== "Missed Penalty" && e.detail !== "Own Goal") {
            const nm = e.player?.name;
            if (nm) goals[nm] = (goals[nm] || 0) + 1;
          }
        });
        const scorers = Object.entries(goals).map(([name, count]) => ({ name, team: "", count }));
        log.push(`  ${scorers.length} scorers: ${scorers.map(s=>s.name+'('+s.count+')').join(', ')}`);
        if (!scorers.length) return;

        // Also check for penalty winner from API-Football
        let apiFbPenWinner = null;
        if (apiFx.fixture.status.short === "PEN") {
          if (apiFx.teams.home.winner) apiFbPenWinner = apiFx.teams.home.name;
          else if (apiFx.teams.away.winner) apiFbPenWinner = apiFx.teams.away.name;
        }

        // Find matching match in our output by team name
        const apiHome = normName(fxHome);
        const apiAway = normName(fxAway);
        const match = out.find(m => {
          const h = normName(m.home), a = normName(m.away);
          return (h === apiHome && a === apiAway) || (h === apiAway && a === apiHome);
        });
        if (match) {
          match.scorers = scorers;
          if (apiFbPenWinner) match.penWinner = apiFbPenWinner;
          log.push(`  Matched to: ${match.home} vs ${match.away} — scorers replaced`);
        } else {
          log.push(`  NO MATCH found. apiHome=${apiHome}, apiAway=${apiAway}`);
        }
      } catch (e) { log.push(`  Event fetch error: ${e.message}`); }
    }));
  } catch (e) { log.push(`Top-level error: ${e.message}`); }
  return log;
}

// ---- Handler ----
exports.handler = async function (event) {
  try {
    const out = await fetchWorldcup26();
    inferPenaltyWinners(out);

    const params = event.queryStringParameters || {};
    let debugLog = null;
    if (params.scorers === "1") {
      const apiKey = process.env.APIFOOTBALL_KEY;
      debugLog = await enrichScorers(out, apiKey, params.debug === "1");
    }

    const body = params.debug === "1"
      ? JSON.stringify({ debugLog, sampleMatch: out.find(m => m.home === "England" && m.stage === "Round of 32") }, null, 2)
      : JSON.stringify(out);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
