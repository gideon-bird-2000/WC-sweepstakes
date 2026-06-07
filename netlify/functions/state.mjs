// netlify/functions/state.mjs
// Shared state via Netlify Blobs with explicit credentials + diagnostic errors.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;

  // ?debug=1 — shows env-var status without trying any Blobs operations
  const url = new URL(req.url);
  if (url.searchParams.has("debug")) {
    return Response.json({
      method: req.method,
      hasSiteID: !!siteID,
      siteIDLen: siteID ? siteID.length : 0,
      hasToken: !!token,
      tokenLen: token ? token.length : 0,
      tokenPrefix: token ? token.slice(0, 4) + "…" : null,
      runtime: process.version || "unknown"
    });
  }

  if (!siteID || !token) {
    return Response.json({ error: "Missing BLOBS_SITE_ID or BLOBS_TOKEN env vars" }, { status: 500 });
  }

  let store;
  try {
    store = getStore({ name: "go3-state", siteID, token });
  } catch (e) {
    return Response.json({ error: "Blobs init failed: " + e.message }, { status: 500 });
  }

  if (req.method === "GET") {
    try {
      const text = await store.get("state");
      const data = text ? JSON.parse(text) : null;
      return Response.json(data, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return Response.json({ error: "Read failed: " + e.message }, { status: 500 });
    }
  }

  if (req.method === "POST") {
    try {
      const body = await req.text();
      console.log("[state] POST body length:", body.length);
      await store.set("state", body || "{}");
      console.log("[state] POST save OK");
      return Response.json({ ok: true, t: Date.now(), bodyLen: body.length });
    } catch (e) {
      console.error("[state] POST save failed:", e.message, e.stack);
      return Response.json({ error: "Save failed: " + e.message }, { status: 500 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
};
