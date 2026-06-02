// netlify/functions/state.js
// Shared state for the three competitors via Netlify Blobs (free, built-in).
// GET  /.netlify/functions/state         -> latest state JSON (or null)
// POST /.netlify/functions/state  + body -> overwrites the stored state

const { getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  let store;
  try {
    store = getStore({ name: "go3-state", consistency: "strong" });
  } catch (e) {
    return json(500, { error: "Blobs unavailable: " + e.message });
  }

  if (event.httpMethod === "GET") {
    try {
      const data = await store.get("state", { type: "json" });
      return json(200, data || null);
    } catch (e) {
      // first request before anything written
      return json(200, null);
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      await store.setJSON("state", body);
      return json(200, { ok: true, t: Date.now() });
    } catch (e) {
      return json(500, { error: String(e) });
    }
  }

  return { statusCode: 405, body: "Method not allowed" };
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}
