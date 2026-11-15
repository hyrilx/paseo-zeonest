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
export const resolveDashboard = defineRpc({
  name: "zeonest.billion-context.resolve",
  input: z.object({ workspaceId: id, agentId: id.optional() }),
  output: z.object({ url: z.string(), workspaceId: id }),
});
export const screenId = "billion-context-dashboard";
export function dashboardUrl(origin: string, sessionId?: string): string {
  return origin + "/__bili/" + (sessionId ? "#/session/" + encodeURIComponent(sessionId) : "");
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
