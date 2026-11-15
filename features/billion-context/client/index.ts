import type { PluginClientContext } from "@getpaseo/plugin/client";
import { screenId } from "../shared/contracts";
import { DashboardScreen, DashboardSidebar } from "./screen";
import { startPills } from "./runtime";

export default function contribute(client: PluginClientContext) {
  const cleanup: (() => void)[] = [];
  try {
    cleanup.push(client.addScreen({ id: screenId, title: "Billion Context", Component: DashboardScreen }));
    cleanup.push(client.addSidebarHeaderItem({ id: "billion-context-sidebar", title: "Billion Context", Component: DashboardSidebar }));
    cleanup.push(startPills(client));
  } catch (error) { for (const remove of cleanup.reverse()) remove(); throw error; }
  let stopped = false;
  return () => { if (stopped) return; stopped = true; for (const remove of cleanup.reverse()) remove(); };
}
