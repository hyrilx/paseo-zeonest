import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const scopeSchema = z.object({ workspaceId: z.string().min(1).optional() });
export type Scope = z.infer<typeof scopeSchema>;
export const documentKindSchema = z.enum(["settings", "models", "mcp", "preferences"]);
export type DocumentKind = z.infer<typeof documentKindSchema>;
export const preferencesSchema = z.object({
  version: z.literal(1).default(1),
  agentDir: z.string().default(""),
  piExecutable: z.string().min(1).default("pi"),
  confirmDiff: z.boolean().default(true),
  packageBackups: z.record(z.string(), z.unknown()).default({}),
});
export type Preferences = z.infer<typeof preferencesSchema>;
const documentSchema = z.object({
  kind: documentKindSchema, path: z.string(), text: z.string(), revision: z.string(),
  exists: z.boolean(), error: z.string().nullable(),
});
export type ConfigDocument = z.infer<typeof documentSchema>;
export const resourceSchema = z.object({
  id: z.string(), kind: z.enum(["skill", "extension"]), name: z.string(), description: z.string(),
  path: z.string(), scope: z.enum(["global", "project"]), packageSource: z.string().optional(), packageRoot: z.string().optional(),
  enabled: z.boolean(), modelInvocation: z.boolean(),
});
export type Resource = z.infer<typeof resourceSchema>;
const packageSchema = z.object({ source: z.string(), path: z.string().nullable(), version: z.string().nullable(), enabled: z.boolean() });
export const snapshotSchema = z.object({
  scope: scopeSchema, directory: z.string(), agentDir: z.string(), defaultAgentDir: z.string(),
  preferences: preferencesSchema, documents: z.array(documentSchema), globalSettings: z.string(), globalMcp: z.string(),
  resources: z.array(resourceSchema), packages: z.array(packageSchema), warnings: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
const editSchema = z.object({ kind: documentKindSchema, text: z.string().max(1_048_576), revision: z.string() });
const changeSchema = z.object({ path: z.string(), diff: z.string(), additions: z.number(), deletions: z.number() });
export const previewSchema = z.object({
  token: z.string(), title: z.string(), expiresAt: z.string(), confirmationRequired: z.boolean(),
  changes: z.array(changeSchema), artifacts: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number(), changed: z.number() })),
  warnings: z.array(z.string()),
});
export type Preview = z.infer<typeof previewSchema>;
export const listWorkspaces = defineRpc({
  name: "zeonest.pi-settings.workspaces", input: z.object({}),
  output: z.array(z.object({ id: z.string(), name: z.string(), directory: z.string() })),
});
export const readSnapshot = defineRpc({ name: "zeonest.pi-settings.read", input: scopeSchema, output: snapshotSchema });
export const readResource = defineRpc({
  name: "zeonest.pi-settings.resource", input: scopeSchema.extend({ id: z.string() }),
  output: z.object({ text: z.string(), revision: z.string() }),
});
export const prepareChanges = defineRpc({
  name: "zeonest.pi-settings.prepare",
  input: scopeSchema.extend({ edits: z.array(editSchema).min(1).max(4) }), output: previewSchema,
});
export const prepareResource = defineRpc({
  name: "zeonest.pi-settings.prepare-resource",
  input: scopeSchema.extend({ id: z.string(), text: z.string().max(1_048_576), revision: z.string() }), output: previewSchema,
});
export const preparePackage = defineRpc({
  name: "zeonest.pi-settings.prepare-package",
  input: scopeSchema.extend({
    action: z.enum(["install", "remove", "update", "enable", "disable"]), source: z.string().min(1).max(2048),
    revision: z.string(), preferencesRevision: z.string(),
  }), output: previewSchema,
});
export type PackageRequest = z.infer<typeof preparePackage.input>;
export const commitChanges = defineRpc({
  name: "zeonest.pi-settings.commit", input: z.object({ token: z.string(), confirmed: z.boolean() }),
  output: z.object({ message: z.string() }),
});
export const discardChanges = defineRpc({
  name: "zeonest.pi-settings.discard", input: z.object({ token: z.string() }), output: z.object({ discarded: z.boolean() }),
});
