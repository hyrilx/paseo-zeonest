import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { SubscriptionAuthState } from "../shared/contracts";
import { PiSettingsService } from "../server/service";
import { loadSubscriptions, subscriptionSdk } from "../server/subscriptions";

const cli = process.env.ZEONEST_PI_CLI;
test("the real Pi SDK reads local models, native matches and subscription status in an isolated agent", { skip: !cli, timeout: 30_000 }, async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-native-subscriptions-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture-only", models: [{ id: "tiny", contextWindow: 4096, maxTokens: 32 }],
  } } }));
  assert.match(subscriptionSdk(cli!), /dist[\\/]index\.js$/);
  const result = await loadSubscriptions({ executable: cli!, agentDir, signal: new AbortController().signal }, { patterns: ["fixture/*:high", "missing/no-match"] });
  assert.ok(result.providers.length > 0);
  assert.ok(result.providers.every((provider) => !provider.connected));
  assert.ok(result.models.some((model) => model.provider === "fixture" && model.id === "tiny" && model.contextWindow === 4096));
  assert.deepEqual(result.rules, [{ pattern: "fixture/*:high", matches: [{ ref: "fixture/tiny", thinking: "high" }] }, { pattern: "missing/no-match", matches: [] }]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only/);
});

async function statusUntil(service: PiSettingsService, token: string, predicate: (state: SubscriptionAuthState) => boolean) {
  for (let i = 0; i < 150; i++) {
    const state = service.subscriptionAction({ action: "status", token });
    if (predicate(state)) return state;
    await wait(20);
  }
  assert.fail("subscription worker did not enter the expected state");
}

test("isolated subscription worker refreshes, prompts, cancels and logs out without serializing credentials", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-subscription-fixture-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const fixture = join(root, "fixture"); const dist = join(fixture, "dist"); mkdirSync(dist, { recursive: true });
  const executable = join(dist, "cli.js");
  writeFileSync(executable, "#!/usr/bin/env node\nthrow Error('CLI must not run');\n", { mode: 0o700 });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", name: "@earendil-works/pi-coding-agent", version: "1.5.2", bin: { pi: "dist/cli.js" }, exports: { ".": { import: "./dist/index.js" } } }));
  writeFileSync(join(dist, "index.js"), `
import { readFile, writeFile } from 'node:fs/promises';
export const SettingsManager = { create: () => ({ getOrCreateDeviceId: () => 'fixture-device', flush: async () => {} }) };
export const ModelRuntime = { create: async ({ authPath, allowModelNetwork }) => {
  if (allowModelNetwork !== false) throw new Error('Network on startup');
  const stored = async () => JSON.parse(await readFile(authPath, 'utf8'));
  return {
    getProviders: () => [{ id: 'sub', name: 'Subscription fixture', auth: { oauth: { isSubscription: true } } }, { id: 'other', auth: {} }],
    getAvailable: async () => [{ provider: 'sub', id: 'tiny', contextWindow: 100, maxTokens: 20 }],
    listCredentials: async () => Object.entries(await stored()).map(([providerId, value]) => ({ providerId, type: value.type })),
    refresh: async ({ providers, allowNetwork }) => {
      if (providers.join(',') !== 'sub' || !allowNetwork) throw new Error('Wrong refresh');
      return { aborted: false, errors: new Map() };
    },
    login: async (id, type, { notify, prompt }, { getDeviceId }) => {
      if (type !== 'oauth' || getDeviceId() !== 'fixture-device') throw new Error('Wrong auth');
      notify({ type: 'device_code', verificationUri: 'https://example.test/device', userCode: 'ABCD' });
      const result = await prompt({ type: 'manual_code', message: 'Enter code' });
      if (result !== 'fixture-answer') throw new Error('Wrong reply');
      await writeFile(authPath, JSON.stringify({ ...(await stored()), [id]: { type, access: 'fixture-secret-access', refresh: 'fixture-secret-refresh' } }));
    },
    logout: async (id) => { const data = await stored(); delete data[id]; await writeFile(authPath, JSON.stringify(data)); },
    settleCredentialWrites: async () => {},
  };
} };
export const resolveModelScopeWithDiagnostics = async (_patterns, runtime) => ({ scopedModels: (await runtime.getAvailable()).map(model => ({ model })) });
`);
  const authPath = join(agentDir, "auth.json");
  const other = { type: "api_key", key: "fixture-other-key" };
  writeFileSync(authPath, JSON.stringify({ other }));
  writeFileSync(join(agentDir, "zeonest-pi-settings.json"), JSON.stringify({ piExecutable: executable }));
  const service = new PiSettingsService({ agentDir, home: root, workspaceDirectory: async () => root });
  t.after(() => { service.dispose(); rmSync(root, { recursive: true, force: true }); });
  const { documents } = await service.snapshot({});
  const input = { confirmed: true as const, revision: documents.find((doc) => doc.kind === "models")!.revision, preferencesRevision: documents.find((doc) => doc.kind === "preferences")!.revision };
  const first = await service.listSubscriptions({ ...input, patterns: ["sub/*"] });
  assert.deepEqual(first.providers, [{ id: "sub", name: "Subscription fixture", connected: false }]);
  assert.deepEqual((await service.listSubscriptions({ ...input, patterns: [], refresh: "sub" })).models, first.models);
  await assert.rejects(service.listSubscriptions({ ...input, patterns: [], revision: "stale" }));
  const cancelled = await service.startSubscription({ ...input, action: "login", provider: "sub" });
  const challenge = await statusUntil(service, cancelled.token, (state) => !!state.prompt);
  assert.deepEqual(challenge, { status: "pending", url: "https://example.test/device", code: "ABCD", prompt: { id: 1, kind: "manual_code", message: "Enter code", options: undefined } });
  assert.throws(() => service.subscriptionAction({ token: cancelled.token, action: "reply", id: 999, value: "irrelevant" }), /登录已结束/);
  assert.deepEqual(service.subscriptionAction({ token: cancelled.token, action: "cancel" }), { status: "cancelled" });
  await assert.rejects(service.startSubscription({ ...input, action: "login", provider: "sub" }), /正在运行/);
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { other });
  let login: { token: string } | undefined;
  for (let i = 0; i < 150 && !login; i++) {
    try { login = await service.startSubscription({ ...input, action: "login", provider: "sub" }); }
    catch (error) { assert.match(String(error), /正在运行/); await wait(20); }
  }
  assert.ok(login);
  const prompt = await statusUntil(service, login.token, (state) => !!state.prompt);
  service.subscriptionAction({ token: login.token, action: "reply", id: prompt.prompt!.id, value: "fixture-answer" });
  assert.deepEqual(await statusUntil(service, login.token, (state) => state.status !== "pending"), { status: "success" });
  const connected = await service.listSubscriptions({ ...input, patterns: [] });
  assert.equal(connected.providers[0]?.connected, true);
  assert.doesNotMatch(JSON.stringify(connected), /fixture-secret|fixture-other-key/);
  const logout = await service.startSubscription({ ...input, action: "logout", provider: "sub" });
  assert.deepEqual(await statusUntil(service, logout.token, (state) => state.status !== "pending"), { status: "success" });
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { other });
});
