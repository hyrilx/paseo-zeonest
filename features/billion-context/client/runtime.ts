import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listDashboardAgents, screenId } from "../shared/contracts";

export function startPills(client: PluginClientContext, intervalMs = 3000) {
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function clear() { for (const pill of pills.values()) pill.registration.remove(); pills.clear(); }
  async function poll() {
    try {
      const agents = await Promise.race([
        client.rpc(listDashboardAgents, {}),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("会话列表超时")), 10000); }),
      ]);
      if (stopped) return;
      const current = new Map(agents.map((agent) => [agent.agentId, agent]));
      for (const [id, pill] of pills) {
        if (current.get(id)?.workspaceId !== pill.workspaceId) { pill.registration.remove(); pills.delete(id); }
      }
      for (const { agentId, workspaceId } of current.values()) {
        if (pills.has(agentId)) continue;
        const registration = client.addComposerPill({
          id: "billion-context-" + agentId, workspaceId, agentId,
          button: { title: "查看当前会话的 Billion Context 详情", label: "上下文详情", icon: "ChartPie",
            behavior: { kind: "action", onPress: () => {
              if (!stopped) client.openScreen({ screenId, params: { workspaceId, agentId } });
            } } },
        });
        pills.set(agentId, { registration, workspaceId });
      }
    } catch {
      if (!stopped) clear(); // Never leave registrations for an unverified, stale workspace.
    } finally {
      clearTimeout(deadline); deadline = undefined;
      if (!stopped) timer = setTimeout(() => { void poll(); }, intervalMs);
    }
  }
  void poll();
  return () => { if (stopped) return; stopped = true; clearTimeout(timer); clearTimeout(deadline); clear(); };
}
