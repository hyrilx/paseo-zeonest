import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPreferencesStore, observePreferences } from "../client/preferences";
import { preferencesSchema } from "../shared/settings";
import { agent, deferred, fakeHost, message, startSessionStats } from "./fixtures/host";

const flush = () => delay(5);
const defaults = () => preferencesSchema.parse({});

test("preference snapshots are stable and do not notify after unsubscribe", () => {
  const source = createPreferencesStore();
  const initial = source.get();
  let changes = 0;
  const unsubscribe = source.subscribe(() => changes++);
  source.set(defaults());
  assert.equal(source.get(), initial);
  assert.equal(changes, 0);
  source.set({ ...defaults(), missingValues: "label" });
  assert.equal(changes, 1);
  unsubscribe();
  source.set(defaults());
  assert.equal(changes, 1);
});

test("one settings read is shared across pills, and a live window change never resets totals or weighted TPS", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = fakeHost([agent(), agent("b"), agent("c")]);
  let now = 0;
  const stop = startSessionStats(host.client, () => now); t.after(stop);
  await flush();
  assert.equal(host.settingsReads, 1);
  const pill = host.pills[0]!;
  const behavior = pill.contribution.button.behavior;
  host.emit(message({ type: "turn_started", turnId: "t", provider: "pi" }));
  now = 1000;
  host.emit(message({ type: "timeline", turnId: "t", provider: "pi", item: { type: "assistant_message", text: "abcd" } }, 1));
  now = 2000;
  host.emit(message({ type: "timeline", turnId: "t", provider: "pi", item: { type: "assistant_message", text: "abcdefgh" } }, 2));
  now = 6000;
  host.setSettingsRead(async () => ({ status: "ready", revision: "r2", values: { ...defaults(), instantWindowSeconds: 5, visibleMetrics: ["tools"], showCounts: false } }));
  t.mock.timers.tick(2000); await flush();
  assert.equal(host.settingsReads, 2);
  assert.equal(pill.source().get().instantTps, 0.4);
  assert.equal(pill.source().get().averageTps, 3);
  assert.equal(pill.source().get().steps, 1);
  assert.equal(pill.configuration().get().values.instantWindowSeconds, 5);
  assert.equal(pill.contribution.button.behavior, behavior);
  assert.equal(host.fetches.length, 3);
  assert.equal(host.pills.length, 3);
  await stop();
  t.mock.timers.tick(10000); await flush();
  assert.equal(host.settingsReads, 2);
});

test("failed reads retain defaults or the last valid preferences, and a manual retry clears the error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = fakeHost();
  host.setSettingsRead(async () => { throw new Error("offline"); });
  const observer = observePreferences(host.client, () => {}); t.after(() => observer.stop());
  await flush();
  assert.deepEqual(observer.source.get().values, defaults());
  assert.equal(observer.source.get().error, "配置读取失败");
  host.setSettingsRead(async () => ({ status: "ready", revision: "r2", values: { ...defaults(), instantWindowSeconds: 1 } }));
  await observer.refresh();
  assert.equal(observer.source.get().values.instantWindowSeconds, 1);
  assert.equal(observer.source.get().error, "");
  host.setSettingsRead(async () => ({ status: "ready", values: { instantWindowSeconds: 9 } }));
  t.mock.timers.tick(2000); await flush();
  assert.equal(observer.source.get().values.instantWindowSeconds, 1);
  assert.equal(observer.source.get().error, "配置读取失败");
  host.setSettingsRead(async () => ({ status: "invalid", error: "corrupt document" }));
  await observer.refresh();
  assert.equal(observer.source.get().values.instantWindowSeconds, 1);
  assert.equal(observer.source.get().error, "配置读取失败");
});

test("preference reads never overlap and late results after cleanup cannot notify or schedule another read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = fakeHost();
  const read = deferred<unknown>(); host.setSettingsRead(() => read.promise);
  let changes = 0;
  const observer = observePreferences(host.client, () => changes++);
  const initial = observer.source.get();
  await observer.refresh();
  t.mock.timers.tick(10000); await flush();
  assert.equal(host.settingsReads, 1);
  observer.stop(); observer.stop();
  read.resolve({ status: "ready", revision: "r2", values: { ...defaults(), instantWindowSeconds: 5 } });
  await flush(); t.mock.timers.tick(10000); await flush();
  assert.equal(observer.source.get(), initial);
  assert.equal(changes, 0);
  assert.equal(host.settingsReads, 1);
});
