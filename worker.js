import searchHandler from "./api/search.js";
import cutoutHandler from "./api/cutout.js";
import realcolorHandler from "./api/realcolor.js";
import { runLegacy } from "./functions/_lib/bridge.js";

const apiHandlers = new Map([
  ["/api/search", searchHandler],
  ["/api/cutout", cutoutHandler],
  ["/api/realcolor", realcolorHandler]
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const handler = apiHandlers.get(url.pathname.replace(/\/$/, ""));

    if (!handler) {
      return Response.json({ error: "API endpoint not found." }, { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" }
      });
    }

    return runLegacy(handler, request);
  }
};
