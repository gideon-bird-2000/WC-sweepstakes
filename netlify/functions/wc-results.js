// netlify/functions/wc-results.js
// Fetches WC 2026 results from worldcup26.ir — free, no API key, includes scorers.
// Returns shape matching what applySync() expects in index.html.

const API_URL = "https://worldcup26.ir/get/games";

// Resolve TBD knockout team labels into actual stage names matching local fixtures.
// worldcup26.ir uses group="R32"/"R16"/"QF"/"SF"/"FINAL"/"3RD"; map to our stages.
const STAGE_MAP = {
  R32:   "Round of 32",
  R16:   "Round of 16",
  QF:    "Quarter-final",
  SF:    "Semi-final",
  "3RD": "Third place",
  FINAL: "Final",
};

// Parse the home_scorers/away_scorers field. Examples:
//   "{\"V. Júnior 32'\"}"
//   "{\"Felix Nmecha 7'\",\"K. Havertz 45'+5'(p)\",\"D. Bobadilla 7'(OG)\"}"
//   "{“J. Quiñones 9'”,”R. Jiménez 67'”}"  (fancy quotes — match 1 quirk)
//   "null"  or  null
function parseScorers(raw) {
  if (!raw || raw === "null" || raw === null) return [];
  // Strip enclosing { }
  let s = String(raw).trim().replace(/^\{/, "").replace(/\}$/, "");
  // Normalize fancy unicode quotes to ASCII
  s = s.replace(/[\u201C\u201D\u2018\u2019]/g, '"');
  // Split on quote-comma-quote, then strip remaining quotes
  const parts = s.split(/"\s*,\s*"/).map(p => p.replace(/^"|"$/g, "").trim()).filter(Boolean);
  // Each part looks like: "V. Júnior 32'" or "K. Havertz 45'+5'(p)" or "D. Bobadilla 7'(OG)"
  return parts.map(p => {
    const isOG = /\(OG\)/i.test(p);
    // Strip trailing minute and annotations. Handles all observed formats:
    //   " 32'"  " 45'+5'(p)"  " 7'(OG)"  " 90+"  " 90+3"  " 89'(OG)"
    // Apostrophes are optional since worldcup26.ir sometimes drops them.
    const name = p.replace(/\s*\d+'?(\+\d*'?)?\s*(\(OG\)|\(p\))?\s*$/i, "").trim();
    return { name, isOG };
  });
}

// Aggregate parsed scorers, EXCLUDING own goals (they don't help the scorer's owner)
function aggregateScorers(parsed) {
  const counts = {};
  parsed.forEach(p => {
    if (p.isOG) return;
    if (!p.name) return;
    counts[p.name] = (counts[p.name] || 0) + 1;
  });
  return Object.entries(counts).map(([name, count]) => ({ name, team: "", count }));
}

exports.handler = async function () {
  try {
    const res = await fetch(API_URL, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      return json(502, { error: `worldcup26.ir API error ${res.status}` });
    }
    const data = await res.json();
    const games = Array.isArray(data.games) ? data.games : [];

    const out = games.map(g => {
      const finished = String(g.finished).toUpperCase() === "TRUE";

      // For finished games we have actual team names; for KO TBDs we have labels
      const home = g.home_team_name_en || g.home_team_label || "";
      const away = g.away_team_name_en || g.away_team_label || "";

      // Stage: groups use "Group X" style; KO uses STAGE_MAP
      let stage = "";
      if (g.type === "group") {
        stage = "Group Stage";
      } else if (STAGE_MAP[g.group]) {
        stage = STAGE_MAP[g.group];
      } else {
        stage = g.group || "";
      }

      // Parse scorers, drop own goals
      const homeScorers = aggregateScorers(parseScorers(g.home_scorers));
      const awayScorers = aggregateScorers(parseScorers(g.away_scorers));
      const scorers = [...homeScorers, ...awayScorers];

      // Date: convert "06/13/2026 18:00" (US format) to ISO. Assume UTC for sync purposes;
      // local kickoff times are already baked into index.html's KICKOFFS const so this only
      // affects the applySync time-update step which the client tolerates.
      let date = null;
      if (g.local_date) {
        const m = g.local_date.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
        if (m) {
          const [, mo, da, yr, hr, mn] = m;
          date = `${yr}-${mo}-${da}T${hr}:${mn}:00Z`;
        }
      }

      // Score: strings -> ints, only for finished
      const hs = finished ? parseInt(g.home_score, 10) : null;
      const as = finished ? parseInt(g.away_score, 10) : null;

      return {
        home,
        away,
        homeScore: hs,
        awayScore: as,
        finished,
        stage,
        date,
        penWinner: null,
        scorers,
      };
    });

    // Infer penalty winners for drawn KO matches.
    // In knockout rounds a draw = penalties happened. Check which team advanced
    // by looking at whether either team appears in a later round's fixtures.
    const KO_STAGES = ["Round of 32","Round of 16","Quarter-final","Semi-final","Final","Third place"];
    const nextStage = { "Round of 32":"Round of 16", "Round of 16":"Quarter-final", "Quarter-final":"Semi-final", "Semi-final":"Final" };
    const isPlaceholder = n => !n || /\b(winner|loser|runner|group|3rd|match)\b/i.test(n);

    out.forEach(m => {
      if (!m.finished || m.homeScore == null) return;
      if (!KO_STAGES.includes(m.stage)) return;
      if (m.homeScore !== m.awayScore) return; // not a draw, no pens needed
      if (isPlaceholder(m.home) || isPlaceholder(m.away)) return;

      // Search all later fixtures for either team appearing
      const ns = nextStage[m.stage];
      // Also check "Third place" for semi-final losers
      const searchStages = ns ? [ns] : [];
      if (m.stage === "Semi-final") searchStages.push("Third place");

      for (const laterMatch of out) {
        if (!searchStages.includes(laterMatch.stage)) continue;
        const lh = (laterMatch.home || "").toLowerCase();
        const la = (laterMatch.away || "").toLowerCase();
        if (isPlaceholder(laterMatch.home) && isPlaceholder(laterMatch.away)) continue;

        const homeInLater = !isPlaceholder(laterMatch.home) && lh === m.home.toLowerCase() ||
                            !isPlaceholder(laterMatch.away) && la === m.home.toLowerCase();
        const awayInLater = !isPlaceholder(laterMatch.home) && lh === m.away.toLowerCase() ||
                            !isPlaceholder(laterMatch.away) && la === m.away.toLowerCase();

        if (homeInLater && !awayInLater) { m.penWinner = m.home; break; }
        if (awayInLater && !homeInLater) { m.penWinner = m.away; break; }
      }
    });

    return json(200, out);
  } catch (err) {
    return json(502, { error: String(err) });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}
