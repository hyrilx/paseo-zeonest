import assert from "node:assert/strict";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferencesSchema } from "../shared/settings";
import { serviceStatus, serviceControl } from "../shared/managed-contracts";
import { fakeManager } from "./fixtures/managed";
import contribute from "../server/index";
import contributeSettings from "../server/settings";

function fixture(t: { after(fn: () => Promise<void>): void }, invalid = false) {
  const f = fakeManager(); const handlers = new Map<string, Function>(); const hooks = new Map<string, Function>();
  const server = { registerSettings: () => ({ read: async () => invalid ? { status: "invalid", error: "invalid test preferences" } : { status: "ready", values: preferencesSchema.parse({ biliCommand: "/test/bili" }) } }),
    handle: (contract: { name: string }, fn: Function) => { handlers.set(contract.name, fn); },
    addHook: (name: string, fn: Function) => { hooks.set(name, fn); return () => { hooks.delete(name); }; },
  } as unknown as PluginServerContext;
  const stopSettings = contributeSettings(server, f.manager);
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => { await stop?.(); await stopSettings(); });
  const request = { provider: "pi", purpose: "interactive", agentId: "agent", workspaceId: "w", cwd: "/test", reason: "create", env: { KEEP: "yes", BILI_PI_INLINE: "1", BILLION_CONTEXT_ATTACH: "http://stale:1" } };
  const context = { signal: new AbortController().signal };
  return { ...f, handlers, hooks, server, request, context, start() { stop = contribute(server); return stop; } };
}
test("settings declare service controls synchronously without starting a process while disabled", async (t) => {
  const f = fixture(t); assert.deepEqual([...f.handlers.keys()].sort(), [serviceStatus.name, serviceControl.name].sort());
  assert.deepEqual(f.calls, []); assert.equal((await f.handlers.get(serviceStatus.name)!({})).enabled, false);
});
test("invalid editable preferences do not block status or explicit stop of the owned service", async (t) => {
  const f = fixture(t, true);
  await f.handlers.get(serviceStatus.name)!({});
  await f.handlers.get(serviceControl.name)!({ action: "stop", revision: "r1" });
  assert.ok(f.calls.includes("stop"));
  await assert.rejects(f.handlers.get(serviceControl.name)!({ action: "start", revision: "r1" }), /配置无效/);
});
test("Pi before hook pins attach origin and disables inline while preserving full request/env", async (t) => {
  const f = fixture(t); f.start();
  const transformed = await f.hooks.get("agent.open.before")!({ request: f.request }, f.context);
  assert.equal(transformed.cwd, f.request.cwd); assert.equal(transformed.agentId, "agent"); assert.equal(transformed.reason, "create");
  assert.deepEqual(transformed.env, { KEEP: "yes", BILI_PI_INLINE: "0", BILLION_CONTEXT_ATTACH: "http://127.0.0.1:42001" });
  assert.equal(f.request.env.BILI_PI_INLINE, "1"); assert.deepEqual(f.calls, ["enable:/test/bili", "ensure:/test/bili"]);
});
test("history and non-Pi sessions never receive launcher environment", async (t) => {
  const f = fixture(t); f.start(); const hook = f.hooks.get("agent.open.before")!;
  assert.equal(await hook({ request: { ...f.request, provider: "claude" } }, f.context), undefined);
  assert.equal(await hook({ request: { ...f.request, purpose: "history" } }, f.context), undefined);
  assert.equal(f.calls.filter((value) => value.startsWith("ensure:")).length, 0);
});
test("failed service readiness blocks Pi; no inline or unrelated-instance fallback", async (t) => {
  const f = fixture(t); f.fail(new Error("test service unavailable")); f.start();
  await assert.rejects(f.hooks.get("agent.open.before")!({ request: f.request }, f.context), /service unavailable/);
});
test("explicit disabled/conflicting native environment and cancelled launches are rejected", async (t) => {
  const f = fixture(t); f.start(); const hook = f.hooks.get("agent.open.before")!;
  for (const env of [{ BILLION_CONTEXT_PLUGIN: "0" }, { BILI_NATIVE_PI: "0" }, { BILI_PROVIDER_REWRITES: "" }]) {
    await assert.rejects(hook({ request: { ...f.request, env } }, f.context), /禁用了/);
  }
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(hook({ request: f.request }, { signal: aborted.signal }), /已取消/);
});
test("cleanup unregisters hook and stops monitoring but never sends service stop", async (t) => {
  const f = fixture(t); const stop = f.start(); const hook = f.hooks.get("agent.open.before")!;
  await hook({ request: f.request }, f.context); await stop();
  assert.equal(f.hooks.size, 0); assert.equal(f.calls.includes("stop"), false);
  await assert.rejects(hook({ request: f.request }, f.context), /已取消/);
});
test("settings controls remain available after business cleanup and reject closed entry", async (t) => {
  const f = fixture(t); const stop = f.start(); await stop();
  await f.handlers.get(serviceControl.name)!({ action: "stop", revision: "r1" }); assert.ok(f.calls.includes("stop"));
});
