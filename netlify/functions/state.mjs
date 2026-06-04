// netlify/functions/state.mjs
// Shared state via Netlify Blobs, using explicit credentials passed via env vars.
// Required env vars: BLOBS_SITE_ID, BLOBS_TOKEN

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;
  if (!siteID || !token) {
    return Response.json({ error: "Missing BLOBS_SITE_ID or BLOBS_TOKEN env vars" }, { status: 500 });
  }

  let store;
  try {
    store = getStore({ name: "go3-state", siteID, token });
  } catch (e) {
    return Response.json({ error: "Blobs init: " + e.message }, { status: 500 });
  }

  if (req.method === "GET") {
    try {
      const text = await store.get("state");
      const data = text ? JSON.parse(text) : null;
      return Response.json(data, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json(null);
    }
  }

  if (req.method === "POST") {
    try {
      const body = await req.text();
      await store.set("state", body || "{}");
      return Response.json({ ok: true, t: Date.now() });
    } catch (e) {
      return Response.json({ error: "Save: " + e.message }, { status: 500 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
};
