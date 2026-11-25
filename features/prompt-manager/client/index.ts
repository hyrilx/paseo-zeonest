import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startPromptManager } from "./runtime";

export default function contribute(client: PluginClientContext) {
  return startPromptManager(client);
}
