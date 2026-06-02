// netlify/functions/state.js
// Shared state for the three competitors via Netlify Blobs.
// GET  -> latest stored state (or null)
// POST -> overwrites stored state with request body

const { getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  let store;
  try {
    store = getStore("go3-state");
  } catch (e) {
    return json(500, { error: "Blobs init failed: " + e.message });
  }

  if (event.httpMethod === "GET") {
    try {
      const text = await store.get("state");
      if (!text) return json(200, null);
      return json(200, JSON.parse(text));
    } catch (e) {
      return json(200, null);
    }
  }

  if (event.httpMethod === "POST") {
    try {
      await store.set("state", event.body || "{}");
      return json(200, { ok: true, t: Date.now() });
    } catch (e) {
      return json(500, { error: "Save failed: " + e.message });
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
