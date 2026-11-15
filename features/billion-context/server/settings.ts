import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "../shared/settings";
import { setPreferencesReader } from "./configuration";

export default function contributeSettings(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  return setPreferencesReader(async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error("Billion Context 配置无效：" + state.error);
    return state.values;
  });
}
