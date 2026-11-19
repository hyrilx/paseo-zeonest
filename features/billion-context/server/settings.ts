import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "../shared/settings";
import { setPreferencesReader, readPreferences } from "./configuration";
import { serviceControl, serviceStatus } from "../shared/managed-contracts";
import { setServiceManager } from "./managed-context";
import { ManagedService, type ServiceManager } from "./managed-service";

export default function contributeSettings(server: PluginServerContext, manager: ServiceManager = new ManagedService()) {
  const settings = server.registerSettings(preferences);
  let closed = false;
  const removeReader = setPreferencesReader(async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error("Billion Context 配置无效：" + state.error);
    return state.values;
  });
  const removeManager = setServiceManager(manager);
  server.handle(serviceStatus, async () => {
    if (closed) throw new Error("服务配置入口已停止");
    return manager.status();
  });
  server.handle(serviceControl, async (input) => {
    if (closed) throw new Error("服务配置入口已停止");
    // Stopping an owned process must remain possible even when editable preferences are invalid.
    const command = input.action === "stop" ? "" : (await readPreferences()).biliCommand;
    if (closed) throw new Error("服务配置入口已停止");
    return manager.control(input.action, input.revision, command, input.confirmPortChange);
  });
  return async () => { if (closed) return; closed = true; removeManager(); removeReader(); await manager.close(); };
}
