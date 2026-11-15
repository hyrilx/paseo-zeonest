import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listDashboardAgents, listDashboardWorkspaces, resolveDashboard } from "../shared/contracts";
import { readPreferences } from "./configuration";
import { listAgents, listWorkspaces, resolveTarget } from "./service";

export default function contribute(server: PluginServerContext) {
  const controller = new AbortController();
  const alive = () => !controller.signal.aborted;
  server.handle(listDashboardAgents, (_, { paseo }) => listAgents(paseo, alive));
  server.handle(listDashboardWorkspaces, (_, { paseo }) => listWorkspaces(paseo, alive));
  server.handle(resolveDashboard, async (input, { paseo }) => {
    const preferences = await readPreferences();
    return resolveTarget(paseo, input, preferences, controller.signal);
  });
  return () => { controller.abort(); };
}
