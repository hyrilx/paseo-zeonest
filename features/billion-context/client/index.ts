import type { PluginClientContext } from "@getpaseo/plugin/client";
import { screenId } from "../shared/contracts";
import { DashboardScreen, DashboardSidebar } from "./screen";

export default function contribute(client: PluginClientContext) {
  const cleanup: (() => void)[] = [];
  let stopped = false;
  try {
    cleanup.push(client.addScreen({ id: screenId, title: "Billion Context", Component: DashboardScreen }));
    cleanup.push(client.addSidebarHeaderItem({ id: "billion-context-sidebar", title: "Billion Context", Component: DashboardSidebar }));
    cleanup.push(client.addCommandCenterItem({
      id: "billion-context-session", title: "Billion Context：查看当前会话详情", icon: "ChartPie",
      context: "agent", keywords: ["上下文", "上下文详情", "dashboard", "session"],
      onSelect({ workspace, agent, openScreen }) {
        if (!stopped) openScreen({ screenId, params: {
          workspaceId: workspace.id, agentId: agent.id, openedAt: String(Date.now()),
        } });
      },
    }));
  } catch (error) { stopped = true; for (const remove of cleanup.reverse()) remove(); throw error; }
  return () => { if (stopped) return; stopped = true; for (const remove of cleanup.reverse()) remove(); };
}
