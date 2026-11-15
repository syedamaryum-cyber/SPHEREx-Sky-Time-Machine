import handler from "../../api/cutout.js";
import { runLegacy } from "../_lib/bridge.js";

async function cacheKeyFor(request) {
  const body = await request.clone().json();
  const identity = JSON.stringify({
    accessUrl: String(body.accessUrl || ""),
    ra: Number(body.ra),
    dec: Number(body.dec),
    size: body.size == null ? 0.05 : Number(body.size)
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return new Request(new URL("/__spherex_cache/cutout/" + hash, request.url).toString());
}

export async function onRequestPost({ request }) {
  let cache;
  let key;
  try {
    cache = caches.default;
    key = await cacheKeyFor(request);
    const cached = await cache.match(key);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-SPHEREX-CACHE", "HIT");
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers
      });
    }
  } catch (error) {
    console.warn("SPHEREx edge-cache lookup unavailable:", error?.message || error);
    return runLegacy(handler, request);
  }

  const response = await runLegacy(handler, request);
  if (!response.ok) return response;

  const storedHeaders = new Headers(response.headers);
  storedHeaders.set("Cache-Control", "public, max-age=86400");
  storedHeaders.delete("X-SPHEREX-CACHE");
  const stored = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers: storedHeaders
  });

  try {
    await cache.put(key, stored);
  } catch (error) {
    console.warn("SPHEREx edge-cache store unavailable:", error?.message || error);
  }

  const clientHeaders = new Headers(storedHeaders);
  clientHeaders.set("X-SPHEREX-CACHE", "MISS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: clientHeaders
  });
}
