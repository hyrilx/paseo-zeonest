import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeShell } from "./client/shell";

export default function contribute(client: PluginClientContext) {
  return contributeShell(client);
}
