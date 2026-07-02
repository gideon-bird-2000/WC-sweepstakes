// netlify/functions/wc-results.js
// Fetches WC 2026 results from worldcup26.ir — free, no API key, includes scorers.
// Some scorer names may be garbled via Persian transliteration — log those manually.

const WC26_URL = "https://worldcup26.ir/get/games";

const STAGE_MAP = {
  R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final",
  SF: "Semi-final", "3RD": "Third place", FINAL: "Final",
};

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

exports.handler = async function () {
  try {
    const res = await fetch(WC26_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`worldcup26.ir error ${res.status}`);
    const data = await res.json();
    const games = Array.isArray(data.games) ? data.games : [];

    const out = games.map(g => {
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

    inferPenaltyWinners(out);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(out),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
