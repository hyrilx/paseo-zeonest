import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listDashboardAgents, listDashboardWorkspaces, resolveDashboard } from "../shared/contracts";
import { activeController } from "./activation";
import { readPreferences } from "./configuration";
import { serviceManager } from "./managed-context";
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
    const target = await serviceManager().ensure(preferences.biliCommand);
    if (closed || controller.signal.aborted) throw new Error("Billion Context 已停止");
    if (input.instanceOrigin && input.instanceOrigin !== target.origin) throw new Error("实例已更换，请重新打开入口");
    return resolveTarget(paseo, { workspaceId: input.workspaceId, agentId: input.agentId }, {
      ...preferences, serverOrigin: target.origin,
    }, controller.signal);
  });
  return () => { closed = true; };
}
