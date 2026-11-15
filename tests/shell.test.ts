import assert from "node:assert/strict";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeShell } from "../server/shell";
import { createLifetime } from "../shared/lifetime";
import { enabledFeatureIds, pendingFeatureIds } from "../shared/selection";
import { shellSettings } from "../shared/settings";
import { createRuntimeStore } from "../client/runtime-store";

const catalog = [
  { id: "one", name: "One", description: "First", version: "0.1.0", tags: [], author: "test" },
  { id: "two", name: "Two", description: "Second", version: "0.1.0", tags: [], author: "test" },
];

test("missing switches are off, unknown and removed features never activate", () => {
  assert.deepEqual(enabledFeatureIds(catalog, {}), []);
  assert.deepEqual(enabledFeatureIds(catalog, { one: true, two: false, removed: true }), ["one"]);
});

test("pending changes include both activation and deactivation", () => {
  assert.deepEqual(pendingFeatureIds(catalog, { two: true }, ["one"]), ["one", "two"]);
  assert.deepEqual(pendingFeatureIds(catalog, { one: true }, ["one"]), []);
});

test("settings defaults contain only switches and reject non-boolean values", () => {
  assert.deepEqual(shellSettings.schema.parse({}), { enabled: {} });
  assert.equal(shellSettings.schema.safeParse({ enabled: { one: "yes" } }).success, false);
});

test("cleanup runs once in reverse order and continues after an error", async () => {
  const lifetime = createLifetime();
  const calls: number[] = [];
  lifetime.add(() => { calls.push(1); });
  lifetime.add(() => { calls.push(2); throw new Error("cleanup"); });
  lifetime.add(async () => { calls.push(3); });
  const disposal = lifetime.dispose();
  assert.equal(lifetime.closed, true);
  assert.equal(disposal, lifetime.dispose());
  await assert.rejects(disposal, AggregateError);
  assert.deepEqual(calls, [3, 2, 1]);
  assert.throws(() => lifetime.add(() => {}));
});

test("client runtime stores are installation-local and subscriptions are removable", () => {
  const first = createRuntimeStore();
  const second = createRuntimeStore();
  let updates = 0;
  const stop = first.subscribe(() => { updates++; });
  first.set({ status: "ready", enabledIds: ["one"], error: null });
  assert.equal(updates, 1);
  assert.equal(second.getSnapshot().status, "loading");
  stop();
  first.set({ status: "error", enabledIds: [], error: "offline" });
  assert.equal(updates, 1);
});

function fakeServer(read: () => Promise<unknown>) {
  let handler: (() => Promise<unknown>) | undefined;
  const server = {
    registerSettings: () => ({ read, subscribe: () => () => {} }),
    handle: (_contract: unknown, callback: () => Promise<unknown>) => { handler = callback; },
  } as unknown as PluginServerContext;
  const cleanup = contributeShell(server);
  return { cleanup, snapshot: () => handler!() };
}

test("server exposes a stable startup snapshot, not current desired switches", async () => {
  let reads = 0;
  const server = fakeServer(async () => {
    reads++;
    return { status: "ready", revision: "1", values: { enabled: { unknown: true } } };
  });
  assert.deepEqual(await server.snapshot(), { enabledIds: [], error: null });
  await server.snapshot();
  assert.equal(reads, 1);
  await server.cleanup();
});

test("invalid settings remain invalid and the management RPC reports startup failure", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const server = fakeServer(async () => ({ status: "invalid", revision: "1", error: "bad settings" }));
    assert.deepEqual(await server.snapshot(), { enabledIds: [], error: "bad settings" });
    await server.cleanup();
  } finally { console.error = original; }
});

test("teardown during a pending read prevents delayed startup", async () => {
  let resolve!: (value: unknown) => void;
  const server = fakeServer(() => new Promise((done) => { resolve = done; }));
  const cleanup = server.cleanup();
  resolve({ status: "ready", revision: "1", values: { enabled: {} } });
  await cleanup;
  assert.deepEqual(await server.snapshot(), { enabledIds: [], error: null });
});
