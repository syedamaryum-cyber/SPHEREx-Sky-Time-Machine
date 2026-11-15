import handler from "../../api/cutout.js";
import { runLegacy } from "../_lib/bridge.js";

export async function onRequestPost({ request }) {
  return runLegacy(handler, request);
}
