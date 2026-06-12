// netlify/functions/wc-results.js
// Fetches World Cup 2026 results from football-data.org (free tier).
//
// SETUP:
//   1. Register free at https://www.football-data.org/client/register
//   2. Copy your API token from your account dashboard
//   3. In Netlify: Project configuration → Environment variables → Add FOOTBALL_DATA_KEY
//   (You can delete the old APIFOOTBALL_KEY — it's no longer used)

const API_BASE   = "https://api.football-data.org/v4";
const COMPETITION = "WC"; // FIFA World Cup

// Map football-data.org stage strings to labels our applySync understands
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
  if (!key) {
    return json(500, { error: "FOOTBALL_DATA_KEY env var not set. Register free at football-data.org." });
  }

  try {
    const res = await fetch(`${API_BASE}/competitions/${COMPETITION}/matches`, {
      headers: { "X-Auth-Token": key },
    });

    if (!res.ok) {
      const body = await res.text();
      return json(502, { error: `API error ${res.status}`, detail: body.slice(0, 300) });
    }

    const data = await res.json();
    const matches = data.matches || [];

    const out = matches
      .filter(m => m.homeTeam?.name && m.awayTeam?.name)
      .map(m => {
        const finished = m.status === "FINISHED";
        const ft       = m.score?.fullTime;

        // Penalty detection
        const hasPens = m.score?.penalties?.home != null;
        let penWinner = null;
        if (hasPens) {
          if      (m.score.winner === "HOME_TEAM") penWinner = m.homeTeam.name;
          else if (m.score.winner === "AWAY_TEAM") penWinner = m.awayTeam.name;
        }

        // Goal scorers — inline in the match response, no extra API calls needed
        const scorerMap = {};
        (m.goals || []).forEach(g => {
          if (g.type === "OWN" || !g.scorer?.name) return; // skip own goals
          scorerMap[g.scorer.name] = (scorerMap[g.scorer.name] || 0) + 1;
        });
        const scorers = Object.entries(scorerMap).map(([name, count]) => ({ name, team: "", count }));

        return {
          home:      m.homeTeam.name,
          away:      m.awayTeam.name,
          homeScore: finished && ft ? ft.home : null,
          awayScore: finished && ft ? ft.away : null,
          finished,
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
