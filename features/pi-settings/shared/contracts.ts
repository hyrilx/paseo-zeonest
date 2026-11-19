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
export const readPreferences = defineRpc({ name: "zeonest.pi-settings.preferences", input: z.object({}), output: z.object({ document: documentSchema, defaultAgentDir: z.string() }) });
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
const modelSchema = z.object({ provider: z.string(), id: z.string(), context: z.string(), maxOutput: z.string(), reasoning: z.boolean(), images: z.boolean() });
export type CatalogModel = z.infer<typeof modelSchema>;
const probeInput = z.object({ preferencesRevision: z.string(), revision: z.string(), confirmed: z.literal(true) });
export const inventoryModels = defineRpc({ name: "zeonest.pi-settings.models", input: probeInput, output: z.array(modelSchema) });
const providerId = z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/);
const modelPattern = z.string().max(600);
const catalogSchema = z.object({
  providers: z.array(z.object({ id: providerId, name: z.string(), connected: z.boolean() })).max(100),
  models: z.array(modelSchema.extend({ contextWindow: z.number().int().nonnegative() })).max(10000),
  rules: z.array(z.object({ pattern: modelPattern, matches: z.array(z.object({ ref: modelPattern, thinking: z.string().optional() })).max(10000) })).max(2000),
  refreshFailed: z.boolean(),
});
export type SubscriptionCatalog = z.infer<typeof catalogSchema>;
export const subscriptionCatalog = defineRpc({
  name: "zeonest.pi-settings.subscriptions", input: probeInput.extend({ refresh: providerId.optional(), patterns: z.array(modelPattern).max(2000) }), output: catalogSchema,
});
const authStateSchema = z.object({
  status: z.enum(["pending", "success", "cancelled", "failed"]),
  url: z.string().optional(), code: z.string().optional(),
  prompt: z.object({ id: z.number().int(), kind: z.enum(["text", "secret", "manual_code", "select"]), message: z.string(), options: z.array(z.object({ value: z.string(), label: z.string() })).optional() }).optional(),
});
export type SubscriptionAuthState = z.infer<typeof authStateSchema>;
export const startSubscription = defineRpc({
  name: "zeonest.pi-settings.subscription-start", input: probeInput.extend({ provider: providerId, action: z.enum(["login", "logout"]) }),
  output: z.object({ token: z.string() }),
});
export const subscriptionAction = defineRpc({
  name: "zeonest.pi-settings.subscription-action", input: z.object({ token: z.uuid(), action: z.enum(["status", "cancel", "reply"]), id: z.number().int().optional(), value: z.string().max(8192).optional() }), output: authStateSchema,
});
export const testModel = defineRpc({
  name: "zeonest.pi-settings.test-model", input: probeInput.extend({ provider: z.string().min(1).max(120), id: z.string().min(1).max(300) }),
  output: z.object({ elapsedMs: z.number() }),
});
export const probeMcp = defineRpc({
  name: "zeonest.pi-settings.probe-mcp", input: probeInput.extend({ name: z.string().min(1).max(256) }),
  output: z.object({ state: z.enum(["connected", "needs-auth", "failed"]), tools: z.array(z.string()) }),
});
const registryPackage = z.object({ name: z.string(), version: z.string(), description: z.string() });
export type RegistryPackage = z.infer<typeof registryPackage>;
export const searchPackages = defineRpc({
  name: "zeonest.pi-settings.search-packages", input: z.object({ query: z.string().trim().max(100) }), output: z.array(registryPackage),
});
const packageUpdate = z.object({
  state: z.enum(["current", "different", "unavailable", "failed"]),
  installed: z.string().nullable(), remote: z.string().nullable(), message: z.string().optional(),
});
export type PackageUpdate = z.infer<typeof packageUpdate>;
export const packageVersion = defineRpc({
  name: "zeonest.pi-settings.package-version", input: scopeSchema.extend({ source: z.string().min(1).max(2048) }), output: packageUpdate,
});
export const commitChanges = defineRpc({
  name: "zeonest.pi-settings.commit", input: z.object({ token: z.string(), confirmed: z.boolean() }),
  output: z.object({ message: z.string() }),
});
export const discardChanges = defineRpc({
  name: "zeonest.pi-settings.discard", input: z.object({ token: z.string() }), output: z.object({ discarded: z.boolean() }),
});
