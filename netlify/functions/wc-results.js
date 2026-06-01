// netlify/functions/wc-results.js
// OPTIONAL: enables the "Auto-sync" button in the app.
// Keeps your API key server-side (never exposed in the page).
//
// SETUP (see README):
//   1. Free key from https://www.api-football.com/  (or via RapidAPI)
//   2. In Netlify: Site settings → Environment variables → add  APIFOOTBALL_KEY = your_key
//   3. Redeploy. Then click "Try auto-sync" in the app's Update tab.
//
// Returns: JSON array of finished matches:
//   [{ home, away, homeScore, awayScore, finished, penWinner, scorers:[{name,team,count}] }]

const API_BASE = "https://v3.football.api-sports.io";
const LEAGUE = 1;       // FIFA World Cup
const SEASON = 2026;
const MAX_EVENT_CALLS = 25; // cap goalscorer lookups so the free quota lasts

exports.handler = async function () {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) {
    return json(500, { error: "APIFOOTBALL_KEY env var not set. See README." });
  }
  const headers = { "x-apisports-key": key };

  try {
    // 1) all fixtures (one call) -> scores + status
    const fxRes = await fetch(`${API_BASE}/fixtures?league=${LEAGUE}&season=${SEASON}`, { headers });
    const fxData = await fxRes.json();
    const fixtures = (fxData.response || []);

    const finished = fixtures.filter(
      (f) => f.fixture && f.fixture.status && ["FT", "AET", "PEN"].includes(f.fixture.status.short)
    );

    // 2) goalscorers for recently finished games (bounded to protect quota)
    const recent = finished
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, MAX_EVENT_CALLS);

    const scorersByFixture = {};
    await Promise.all(
      recent.map(async (f) => {
        try {
          const evRes = await fetch(`${API_BASE}/fixtures/events?fixture=${f.fixture.id}`, { headers });
          const evData = await evRes.json();
          const goals = {};
          (evData.response || []).forEach((e) => {
            if (e.type === "Goal" && e.detail !== "Missed Penalty" && e.detail !== "Own Goal") {
              const nm = e.player && e.player.name ? e.player.name : null;
              const tm = e.team && e.team.name ? e.team.name : null;
              if (nm) {
                const k = nm + "|" + (tm || "");
                goals[k] = (goals[k] || 0) + 1;
              }
            }
          });
          scorersByFixture[f.fixture.id] = Object.entries(goals).map(([k, count]) => {
            const [name, team] = k.split("|");
            return { name, team, count };
          });
        } catch (e) {
          scorersByFixture[f.fixture.id] = [];
        }
      })
    );

    const out = finished.map((f) => {
      let penWinner = null;
      if (f.fixture.status.short === "PEN") {
        // API marks the winner via teams.*.winner
        if (f.teams.home.winner) penWinner = f.teams.home.name;
        else if (f.teams.away.winner) penWinner = f.teams.away.name;
      }
      return {
        home: f.teams.home.name,
        away: f.teams.away.name,
        homeScore: f.goals.home,
        awayScore: f.goals.away,
        finished: true,
        penWinner,
        scorers: scorersByFixture[f.fixture.id] || [],
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
