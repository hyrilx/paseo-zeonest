import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const adapter = z.enum(["npm", "pnpm", "cargo", "cmake", "tauri", "gradle", "xcode"]);
const path = z.string().min(1).max(1024);
const targetKey = z.object({ adapter, project: path, name: z.string().min(1).max(256) });
export const target = targetKey.extend({ source: path, outputs: z.array(path).max(16), operation: z.literal("probe").optional(), confirmed: z.boolean().optional(), blocked: z.string().optional() });
const token = z.string().min(1).max(512).refine((s) => !/[\x00-\x1f\x7f]/u.test(s));
const toolId = z.string().max(64);
export const candidate = z.object({ id: toolId, label: z.string(), paths: z.array(path), requirement: z.string(), version: z.string().optional() });
export const config = z.object({
  target: targetKey, tool: toolId, options: z.array(token).max(16), artifacts: z.array(path).max(8),
});
export const saved = config.extend({ name: z.string().trim().min(1).max(64) });
const commandStep = z.object({ cwd: path, argv: z.array(z.string()) });
export const command = commandStep.extend({ tool: candidate, source: path, preparation: z.array(commandStep).max(4).optional() });
export const status = z.enum(["queued", "running", "stopping", "success", "failed", "stopped", "interrupted"]);
export const run = z.object({
  id: z.uuid(), sequence: z.number().int(), status, configuration: config, command, fingerprint: z.string(),
  confirmedTargets: z.array(z.string()).max(64).optional(), createdAt: z.number(), startedAt: z.number().optional(), endedAt: z.number().optional(), result: z.string().optional(),
});
export const artifact = z.object({ path, state: z.enum(["new", "changed", "existing", "missing", "removed", "unavailable"]) });
export const log = z.object({ cursor: z.number().int().nonnegative(), stream: z.enum(["stdout", "stderr"]), text: z.string() });
export const scope = z.object({ workspaceId: z.string().min(1).max(256) });
export const planInput = scope.extend({ configuration: config });
export const runInput = scope.extend({ id: z.uuid() });
const submitted = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), run }),
  z.object({ kind: z.literal("changed"), command, fingerprint: z.string() }),
]);
function rpc<I extends z.ZodType, O extends z.ZodType>(name: string, input: I, output: O) {
  return defineRpc({ name: `zeonest.build-workbench.${name}`, input, output });
}
export const discover = rpc("discover", scope, z.object({ targets: z.array(target), notices: z.array(z.string()), configurations: z.array(saved) }));
export const tools = rpc("tools", scope.extend({ target: targetKey }), z.object({ candidates: z.array(candidate), requirement: z.string(), issues: z.array(z.string()), selected: toolId.optional() }));
export const selectTool = rpc("select-tool", scope.extend({ target: targetKey, tool: toolId }), z.object({ selected: toolId }));
export const verify = rpc("verify", planInput, candidate);
export const preview = rpc("preview", planInput, z.object({ command, fingerprint: z.string() }));
export const save = rpc("save", scope.extend({ configuration: saved }), z.array(saved));
export const remove = rpc("remove", scope.extend({ name: saved.shape.name }), z.array(saved));
export const start = rpc("start", planInput.extend({ fingerprint: z.string().length(64) }), submitted);
export const retry = rpc("retry", runInput.extend({ fingerprint: z.string().length(64).optional() }), submitted);
export const stop = rpc("stop", runInput, run);
export const list = rpc("list", scope, z.array(run));
export const detail = rpc("detail", runInput.extend({ cursor: z.number().int().nonnegative() }), z.object({
  run, rows: z.array(log), cursor: z.number().int(), truncated: z.boolean(), artifacts: z.array(artifact), artifactsLimited: z.boolean(),
}));

export type Adapter = z.infer<typeof adapter>;
export type TargetKey = z.infer<typeof targetKey>;
export type Target = z.infer<typeof target>;
export type Candidate = z.infer<typeof candidate>;
export type Configuration = z.infer<typeof config>;
export type Saved = z.infer<typeof saved>;
export type Command = z.infer<typeof command>;
export type Run = z.infer<typeof run>;
export type Artifact = z.infer<typeof artifact>;
export type Log = z.infer<typeof log>;
export const targetId = ({ adapter, project, name }: TargetKey) => JSON.stringify([adapter, project, name]);
export const live = (s: Run["status"]) => s === "queued" || s === "running" || s === "stopping";
export const retryable = (s: Run["status"]) => s === "failed" || s === "stopped" || s === "interrupted";
