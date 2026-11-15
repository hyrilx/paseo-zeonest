import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "../shared/settings";

export default function contributeSettings(server: PluginServerContext) {
  server.registerSettings(preferences);
  return () => {};
}
