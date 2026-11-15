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
  // Cache successful, position-specific FITS cutouts at the Cloudflare edge.
  // The source product URL and exact cutout coordinates are part of the key.
  try {
    const cache = caches.default;
    const key = await cacheKeyFor(request);
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

    const response = await runLegacy(handler, request);
    if (response.ok) {
      const storedHeaders = new Headers(response.headers);
      storedHeaders.set("Cache-Control", "public, max-age=86400");
      storedHeaders.delete("X-SPHEREX-CACHE");
      const stored = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: storedHeaders
      });
      await cache.put(key, stored);
      const clientHeaders = new Headers(storedHeaders);
      clientHeaders.set("X-SPHEREX-CACHE", "MISS");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: clientHeaders
      });
    }
    return response;
  } catch (error) {
    // If edge caching is unavailable, preserve the normal live IRSA path.
    console.warn("SPHEREx cutout edge cache unavailable:", error?.message || error);
    return runLegacy(handler, request);
  }
}
