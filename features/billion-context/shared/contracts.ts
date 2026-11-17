import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().min(1).max(2048);
export const listDashboardAgents = defineRpc({
  name: "zeonest.billion-context.agents", input: z.object({}),
  output: z.array(z.object({ agentId: id, workspaceId: id })),
});
export const listDashboardWorkspaces = defineRpc({
  name: "zeonest.billion-context.workspaces", input: z.object({}),
  output: z.array(z.object({ id, name: z.string() })),
});
const instanceSchema = z.object({
  origin: z.string(), instanceId: z.string().max(128).optional(), pid: z.number().int().positive().safe().optional(),
  startedAt: z.number().int().positive().max(8640000000000000).optional(),
});
export type DashboardInstance = z.infer<typeof instanceSchema>;
export function instanceIdentity(instance: DashboardInstance): string | undefined {
  return instance.instanceId && instance.pid && instance.startedAt ? `${instance.instanceId}/${instance.pid}/${instance.startedAt}` : undefined;
}
export const resolveDashboard = defineRpc({
  name: "zeonest.billion-context.resolve",
  input: z.object({ workspaceId: id, agentId: id.optional(), instanceOrigin: z.string().max(2048).optional(), instanceKey: z.string().max(256).optional() }),
  output: z.union([
    z.object({ url: z.string(), workspaceId: id }),
    z.object({ instances: z.array(z.string()).min(2).max(16), instanceDetails: z.array(instanceSchema).max(16).optional(), workspaceId: id }),
  ]),
});
export const screenId = "billion-context-dashboard";
export function dashboardUrl(origin: string, sessionId?: string): string {
  return origin + "/__bili/" + (sessionId ? "#/session/" + encodeURIComponent(sessionId) : "");
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
