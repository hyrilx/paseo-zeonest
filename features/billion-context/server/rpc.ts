import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listDashboardAgents, listDashboardWorkspaces, resolveDashboard } from "../shared/contracts";
import { activeController } from "./activation";
import { readPreferences } from "./configuration";
import { listAgents, listWorkspaces, resolveTarget } from "./service";

export default function contribute(server: PluginServerContext) {
  let closed = false;
  const current = () => {
    if (closed) throw new Error("Billion Context 已停止");
    return activeController();
  };
  server.handle(listDashboardAgents, (_, { paseo }) => {
    const controller = current();
    return listAgents(paseo, () => !closed && !controller.signal.aborted);
  });
  server.handle(listDashboardWorkspaces, (_, { paseo }) => {
    const controller = current();
    return listWorkspaces(paseo, () => !closed && !controller.signal.aborted);
  });
  server.handle(resolveDashboard, async (input, { paseo }) => {
    const controller = current();
    const preferences = await readPreferences();
    if (closed) throw new Error("Billion Context 已停止");
    return resolveTarget(paseo, input, preferences, controller.signal);
  });
  return () => { closed = true; };
}
