// netlify/functions/wc-results.js
// Auto-sync for The Group of Three sweepstakes.
//
// Returns the World Cup 2026 fixtures with:
//   - team names (filtered to real teams; "Winner Match X" placeholders excluded)
//   - scores + winner if finished
//   - goalscorers for recently finished matches (capped to protect the free quota)
//   - stage info so the app can auto-resolve the knockout bracket
//
// SETUP: env var APIFOOTBALL_KEY = your free key from api-football.com

const API_BASE = "https://v3.football.api-sports.io";
const LEAGUE = 1;
const SEASON = 2026;
const MAX_EVENT_CALLS = 25;
const FINISHED = ["FT", "AET", "PEN"];

exports.handler = async function () {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) return json(500, { error: "APIFOOTBALL_KEY env var not set. See README." });
  const headers = { "x-apisports-key": key };

  try {
    const fxRes = await fetch(`${API_BASE}/fixtures?league=${LEAGUE}&season=${SEASON}`, { headers });
    const fxData = await fxRes.json();
    const fixtures = fxData.response || [];

    // Only keep matches with real team names on both sides
    const isReal = (n) => {
      if (!n) return false;
      const l = n.toLowerCase();
      return !l.includes("winner ") && !l.includes("loser ") &&
             !l.startsWith("group ") && !l.includes("runner") && l !== "tbd";
    };
    const relevant = fixtures.filter((f) => isReal(f.teams?.home?.name) && isReal(f.teams?.away?.name));

    // Fetch goalscorer events for recently finished matches only
    const finished = relevant.filter((f) => FINISHED.includes(f.fixture.status.short));
    const recent = [...finished]
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, MAX_EVENT_CALLS);

    const scorersByFx = {};
    await Promise.all(
      recent.map(async (f) => {
        try {
          const evRes = await fetch(`${API_BASE}/fixtures/events?fixture=${f.fixture.id}`, { headers });
          const evData = await evRes.json();
          const goals = {};
          (evData.response || []).forEach((e) => {
            if (e.type === "Goal" && e.detail !== "Missed Penalty" && e.detail !== "Own Goal") {
              const nm = e.player?.name;
              const tm = e.team?.name;
              if (nm) {
                const k = nm + "|" + (tm || "");
                goals[k] = (goals[k] || 0) + 1;
              }
            }
          });
          scorersByFx[f.fixture.id] = Object.entries(goals).map(([k, count]) => {
            const [name, team] = k.split("|");
            return { name, team, count };
          });
        } catch (_) {
          scorersByFx[f.fixture.id] = [];
        }
      })
    );

    const out = relevant.map((f) => {
      const fin = FINISHED.includes(f.fixture.status.short);
      let penWinner = null;
      if (f.fixture.status.short === "PEN") {
        if (f.teams.home.winner) penWinner = f.teams.home.name;
        else if (f.teams.away.winner) penWinner = f.teams.away.name;
      }
      return {
        home: f.teams.home.name,
        away: f.teams.away.name,
        homeScore: fin ? f.goals.home : null,
        awayScore: fin ? f.goals.away : null,
        finished: fin,
        stage: f.league.round,     // e.g. "Group Stage - 1", "Round of 32", "Final"
        date: f.fixture.date,
        penWinner,
        scorers: scorersByFx[f.fixture.id] || [],
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
