import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startStatusClient } from "./runtime";

export default function contribute(client: PluginClientContext) {
  return startStatusClient(client);
}
