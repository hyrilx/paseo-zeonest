import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startSessionStats } from "./runtime";

export default function contribute(client: PluginClientContext) {
  return startSessionStats(client);
}
