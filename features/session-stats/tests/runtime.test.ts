import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { agent, deferred, entry, fakeHost, message, page, startSessionStats, toolItem } from "./fixtures/host";
import type { TimelinePage } from "../client/types";

const flush = () => delay(10);
test("backfills canonical pages oldest-first, merges live counts once, and updates one stable native pill", async (t) => {
  const host = fakeHost();
  let reads = 0;
  host.setRead(async () => ++reads === 1 ? page([entry(toolItem("old"), 3)], { hasOlder: true })
    : page([entry({ type: "user_message", text: "private", messageId: "u" }, 1), entry({ type: "assistant_message", text: "old" }, 2)]));
  let now = 0;
  const stop = startSessionStats(host.client, () => now); t.after(stop);
  await flush();
  assert.equal(host.pills.length, 1);
  const pill = host.pills[0]!;
  const Content = pill.contribution.button.behavior;
  assert.equal(pill.contribution.agentId, "a");
  assert.equal(pill.contribution.workspaceId, "w");
  assert.deepEqual(pill.source().get(), { rounds: 1, steps: 1, tools: 1, modelMs: null, toolMs: null, ttftMs: null, averageTps: null, instantTps: null, status: "ready", partial: false, warning: "" });
  host.emit(message({ type: "turn_started", provider: "pi", turnId: "new" }));
  host.emit(message({ type: "timeline", provider: "pi", turnId: "new", item: { type: "user_message", text: "next", messageId: "new" } }, 4));
  now = 100;
  const output = { type: "timeline", provider: "pi", turnId: "new", item: { type: "assistant_message", text: "abcd" } } as const;
  host.emit(message(output, 5));
  now = 1100; host.emit(message({ ...output, item: { type: "assistant_message", text: "abcdefgh" } }, 6));
  host.emit(message({ ...output, item: { type: "assistant_message", text: "abcdefgh" } }, 6)); // Replay must not double tokens.
  await delay(260);
  assert.equal(pill.label, "≈ 2.0 tok/s");
  assert.equal(pill.source().get().averageTps, 3);
  assert.equal(pill.source().get().rounds, 2);
  assert.equal(pill.source().get().steps, 2);
  assert.equal(host.pills.length, 1);
  assert.equal(pill.contribution.button.behavior, Content);
  host.emit(message({ type: "turn_completed", provider: "pi", turnId: "new" }));
  await delay(260);
  assert.equal(pill.label, "会话统计");
  assert.equal(pill.source().get().modelMs, 1100);
  await stop(); await stop();
  assert.equal(pill.removed, 1);
  assert.equal(host.directoryReleases, 1);
  assert.equal(host.unobserves, 1);
  assert.deepEqual(host.released, ["a"]);
});

test("subscribe-before-read buffers events and ignores overlap with the initial canonical page", async (t) => {
  const host = fakeHost();
  const history = deferred<TimelinePage>();
  host.setRead(() => history.promise);
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  host.emit(message({ type: "timeline", provider: "pi", item: { type: "user_message", text: "echo", messageId: "u" } }, 1));
  host.emit(message({ type: "timeline", provider: "pi", item: { type: "user_message", text: "new", messageId: "u2" } }, 3));
  history.resolve(page([entry({ type: "user_message", text: "echo", messageId: "u" }, 1), entry({ type: "assistant_message", text: "a" }, 2)]));
  await flush();
  const stats = host.pills[0]!.source().get();
  assert.equal(stats.rounds, 2);
  assert.equal(stats.steps, 1);
  assert.equal(stats.partial, false);
});

test("replacement invalidates old history immediately and stale in-flight results cannot overwrite the new epoch", async (t) => {
  const host = fakeHost();
  const old = deferred<TimelinePage>();
  let reads = 0;
  host.setRead(async () => ++reads === 1 ? old.promise : page([entry({ type: "user_message", text: "new", messageId: "new" }, 1)], { epoch: "new" }));
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  host.emit({ agentId: "a", event: { type: "replacement", epoch: "new" } });
  assert.equal(host.pills[0]!.source().get().status, "loading");
  old.resolve(page([entry(toolItem("stale"), 50)]));
  await flush();
  assert.equal(host.pills[0]!.source().get().status, "ready");
  assert.equal(host.pills[0]!.source().get().tools, 0);
  assert.equal(host.pills[0]!.source().get().rounds, 1);
});

test("reconnect clears timing samples, refetches counts and retains the existing pill", async (t) => {
  const host = fakeHost();
  const stop = startSessionStats(host.client, () => 1000); t.after(stop);
  await flush();
  host.emit(message({ type: "turn_started", provider: "pi", turnId: "t" }));
  host.emit(message({ type: "timeline", provider: "pi", turnId: "t", item: { type: "assistant_message", text: "abc" } }, 1));
  host.emit({ agentId: "a", subscriptionId: "s", event: { type: "subscription_restored" } });
  assert.equal(host.pills[0]!.source().get().modelMs, null);
  await flush();
  assert.equal(host.fetches.length, 2);
  assert.equal(host.pills.length, 1);
  assert.equal(host.pills[0]!.source().get().averageTps, null);
});

test("read errors are visible, manual retry recovers and callbacks from released subscriptions are ignored", async (t) => {
  const host = fakeHost();
  host.setRead(async () => { throw new Error("offline"); });
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  const pill = host.pills[0]!;
  assert.equal(pill.source().get().status, "error");
  assert.equal(pill.label, "统计不可用");
  const old = host.handlers.get("a")![0]!;
  host.setRead(async () => page([entry({ type: "user_message", text: "ok", messageId: "u" }, 1)]));
  pill.retry(); await flush();
  old(message({ type: "timeline", provider: "pi", item: toolItem("stale") }, 99));
  await delay(260);
  assert.equal(pill.source().get().status, "ready");
  assert.equal(pill.source().get().tools, 0);
  assert.equal(pill.source().get().rounds, 1);
  assert.equal(host.pills.length, 1);
});

test("workspace moves re-register only that pill; archived/deleted agents release their observations", async (t) => {
  const host = fakeHost();
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  host.update(agent("a", "moved")); await flush();
  assert.equal(host.pills[0]!.removed, 1);
  assert.equal(host.pills[1]!.contribution.workspaceId, "moved");
  host.update({ ...agent("a", "moved"), archivedAt: "now" }); await flush();
  assert.equal(host.pills[1]!.removed, 1);
  host.update(agent("b")); await flush();
  host.remove("b"); await flush();
  assert.equal(host.pills[2]!.removed, 1);
  assert.deepEqual(host.released, ["a", "a", "b"]);
});

test("backfills the complete available history instead of truncating totals after 2,000 entries", async (t) => {
  const host = fakeHost();
  let pageNumber = 25;
  host.setRead(async () => {
    const base = --pageNumber * 100;
    return page(Array.from({ length: 100 }, (_, i) => entry({ type: "user_message", text: "", messageId: String(base + i) }, base + i)), { hasOlder: pageNumber > 0 });
  });
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  assert.equal(host.fetches.length, 25);
  assert.equal(host.pills[0]!.source().get().partial, false);
  assert.equal(host.pills[0]!.source().get().rounds, 2500);
});

test("non-progressing cursors and events without sequence numbers explicitly mark partial counts", async (t) => {
  const host = fakeHost();
  const history = deferred<TimelinePage>();
  let reads = 0;
  host.setRead(async () => ++reads === 1 ? history.promise : page([entry(toolItem("older"), 1)], { hasOlder: true }));
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  host.emit(message({ type: "timeline", provider: "pi", item: { type: "user_message", text: "no sequence" } }));
  history.resolve(page([entry({ type: "user_message", text: "history" }, 2)], { hasOlder: true }));
  await flush();
  assert.equal(host.fetches.length, 3);
  assert.equal(host.pills[0]!.source().get().partial, true);
  assert.match(host.pills[0]!.source().get().warning, /未能完整合并/);
});

test("a failed history read automatically retries and an old ready rejection cannot poison its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = fakeHost();
  const staleReady = deferred<void>();
  host.ready.set("a", staleReady.promise);
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  const pill = host.pills[0]!;
  host.ready.delete("a");
  pill.retry();
  staleReady.reject(new Error("old subscription ended"));
  host.setRead(async () => { throw new Error("offline"); });
  await flush();
  assert.equal(pill.source().get().status, "error");
  host.setRead(async () => page());
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(pill.source().get().status, "ready");
});

test("only 32 active agents are observed, and replayed directory snapshots refresh counts without duplicating pills", async (t) => {
  const agents = Array.from({ length: 40 }, (_, i) => agent(String(i)));
  const host = fakeHost(agents);
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  assert.equal(host.pills.length, 32);
  host.snapshot(agents);
  await flush();
  assert.equal(host.pills.length, 32);
  assert.equal(host.released.length, 32);
  host.update(agent("new")); await flush();
  assert.equal(host.pills.length, 33);
  assert.equal(host.pills.filter((pill) => !pill.removed).length, 32);
  assert.equal(host.pills[0]!.removed, 1);
});

test("history fetch concurrency is bounded and stopping blocks late ready/history results", async () => {
  const host = fakeHost(Array.from({ length: 6 }, (_, i) => agent(String(i))));
  const history = deferred<TimelinePage>();
  host.setRead(() => history.promise);
  const stop = startSessionStats(host.client);
  await flush();
  assert.equal(host.fetches.length, 4);
  await stop();
  history.resolve(page());
  await flush();
  assert.equal(host.fetches.length, 4);
  assert.equal(host.pills.length, 6);
  assert.ok(host.pills.every((pill) => pill.removed === 1));
  assert.equal(host.released.length, 6);
});

test("directory failures clear live statistics and release both directory and timeline resources", async (t) => {
  const host = fakeHost();
  const stop = startSessionStats(host.client); t.after(stop);
  await flush();
  host.directoryError();
  await flush();
  assert.equal(host.pills[0]!.source().get().status, "error");
  assert.equal(host.pills[0]!.source().get().instantTps, null);
  assert.equal(host.directoryReleases, 1);
  assert.equal(host.unobserves, 1);
  assert.equal(host.released.length, 1);
});

test("cleanup releases a directory result that arrives after shutdown without creating a pill", async () => {
  const late = deferred<unknown>();
  let released = 0;
  let pills = 0;
  const client = { paseo: { agents: { list: () => late.promise } }, addComposerPill: () => { pills++; } } as unknown as PluginClientContext;
  const stop = startSessionStats(client);
  await stop();
  late.resolve({ subscription: { release: async () => { released++; } } });
  await flush();
  assert.equal(released, 1);
  assert.equal(pills, 0);
});
