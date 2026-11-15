import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeShell } from "./server/shell";

export default function contribute(server: PluginServerContext) {
  return contributeShell(server);
}
