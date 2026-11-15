import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const statusSchema = z.object({
  agentId: z.string(), workspaceId: z.string(), key: z.string(), text: z.string(),
  command: z.string().nullable(),
});
export type BridgedStatus = z.infer<typeof statusSchema>;
export const snapshotSchema = z.object({
  statuses: z.array(statusSchema),
  warnings: z.array(z.object({ agentId: z.string(), workspaceId: z.string(), message: z.string() })),
});
export type BridgeSnapshot = z.infer<typeof snapshotSchema>;
export const listStatuses = defineRpc({
  name: "zeonest.pi-status-bridge.list", input: z.object({}), output: snapshotSchema,
});
export const expandStatus = defineRpc({
  name: "zeonest.pi-status-bridge.expand",
  input: z.object({ agentId: z.string().min(1), key: z.string().min(1), command: z.string().min(1) }),
  output: z.object({ message: z.string() }),
});
