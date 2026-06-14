// netlify/functions/wc-results.js
// Fetches World Cup 2026 results from football-data.org (free tier).
// Bulk call for all fixtures + individual calls for recently finished matches to get scorers.
//
// SETUP: env var FOOTBALL_DATA_KEY = your free token from football-data.org

const API_BASE    = "https://api.football-data.org/v4";
const COMPETITION = "WC";
const MAX_SCORER_CALLS = 9; // bulk call + up to 9 individual = 10 total (free tier limit)

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

exports.handler = async function () {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return json(500, { error: "FOOTBALL_DATA_KEY env var not set." });

  try {
    // 1. Bulk fetch — all 104 fixtures
    const bulkRes = await fetch(`${API_BASE}/competitions/${COMPETITION}/matches`, {
      headers: { "X-Auth-Token": key },
    });
    if (!bulkRes.ok) {
      const body = await bulkRes.text();
      return json(502, { error: `API error ${bulkRes.status}`, detail: body.slice(0, 300) });
    }
    const bulkData = await bulkRes.json();
    const matches  = bulkData.matches || [];

    // 2. Individual calls for recently finished matches to get goal scorers
    const finished = matches.filter(m => m.status === "FINISHED");
    const recent   = [...finished]
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, MAX_SCORER_CALLS);

    const goalsByMatchId = {};
    await Promise.all(recent.map(async m => {
      try {
        const res  = await fetch(`${API_BASE}/matches/${m.id}`, { headers: { "X-Auth-Token": key } });
        if (!res.ok) return;
        const data = await res.json();
        goalsByMatchId[m.id] = data.goals || [];
      } catch { goalsByMatchId[m.id] = []; }
    }));

    // 3. Build output
    const out = matches
      .filter(m => m.homeTeam?.name && m.awayTeam?.name)
      .map(m => {
        const fin = m.status === "FINISHED";
        const ft  = m.score?.fullTime;

        const hasPens = m.score?.penalties?.home != null;
        let penWinner = null;
        if (hasPens) {
          if      (m.score.winner === "HOME_TEAM") penWinner = m.homeTeam.name;
          else if (m.score.winner === "AWAY_TEAM") penWinner = m.awayTeam.name;
        }

        // Use detailed goals from individual call, fall back to bulk (usually empty)
        const goals = goalsByMatchId[m.id] || m.goals || [];
        const scorerMap = {};
        goals.forEach(g => {
          if (g.type === "OWN" || !g.scorer?.name) return;
          scorerMap[g.scorer.name] = (scorerMap[g.scorer.name] || 0) + 1;
        });
        const scorers = Object.entries(scorerMap).map(([name, count]) => ({ name, team: "", count }));

        return {
          home:      m.homeTeam.name,
          away:      m.awayTeam.name,
          homeScore: fin && ft ? ft.home : null,
          awayScore: fin && ft ? ft.away : null,
          finished:  fin,
          stage:     STAGE_LABELS[m.stage] || m.stage || "",
          date:      m.utcDate,
          penWinner,
          scorers,
        };
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
