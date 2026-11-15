import handler from "../../api/search.js";
import { runLegacy } from "../_lib/bridge.js";

export async function onRequestPost({ request }) {
  return runLegacy(handler, request);
}
