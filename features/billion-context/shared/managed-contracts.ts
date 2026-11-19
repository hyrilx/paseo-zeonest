import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const statusSchema = z.object({
  enabled: z.boolean(), busy: z.boolean(), revision: z.string(),
  phase: z.enum(["unconfigured", "running", "stopped", "error", "conflict"]),
  desired: z.enum(["running", "stopped"]).optional(), origin: z.string().optional(), port: z.number().int().optional(),
  pid: z.number().int().optional(), instanceId: z.string().optional(), startedAt: z.number().optional(),
  version: z.string().optional(), error: z.string().optional(),
});
export type ServiceStatus = z.infer<typeof statusSchema>;
export const serviceStatus = defineRpc({ name: "zeonest.billion-context.service.status", input: z.object({}), output: statusSchema });
const actionSchema = z.enum(["start", "stop", "restart", "rotate"]);
export type ServiceAction = z.infer<typeof actionSchema>;
export const serviceControl = defineRpc({
  name: "zeonest.billion-context.service.control",
  input: z.object({ action: actionSchema, revision: z.string().min(1).max(128), confirmPortChange: z.boolean().optional() }),
  output: statusSchema,
});
