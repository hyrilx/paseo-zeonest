import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startNotes } from "./runtime";

export default function contribute(client: PluginClientContext) {
  return startNotes(client);
}
