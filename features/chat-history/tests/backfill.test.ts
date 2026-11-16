import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { observeHistory } from "../client/backfill";
import { createHistoryTransformer, type HistoryRecord } from "../client/transform";
import { deferred, fakePaseo, history, page, summary, user } from "./fixtures/paseo";

const tick = () => delay(0);
const settled = () => delay(50);
function harness(t: { after(fn: () => Promise<void>): void }, host = fakePaseo()) {
  const snapshots: (readonly HistoryRecord[])[] = [];
  const stop = observeHistory(host.paseo, (records) => snapshots.push(records));
  t.after(stop);
  return { host, snapshots, stop, current: () => createHistoryTransformer(snapshots.at(-1)) };
}
const input = (id = "message-1", text = "Continue here") => ({ item: user(id, text), phase: "complete" as const });

test("backfills only after subscription ready, batches live messages, and keeps each snapshot immutable", async (t) => {
  const host = fakePaseo();
  host.setReady(false);
  const h = harness(t, host);
  await tick();
  assert.equal(host.calls.length, 0);
  const before = h.current();
  host.timelines.get("agent-1")!.ready.resolve();
  await tick();
  assert.deepEqual(host.calls[0]!.options, { direction: "tail", limit: 100, projection: "canonical" });
  for (let index = 0; index < 8; index++) host.emit("agent-1", user(`message-${index}`));
  await settled();
  assert.equal(h.snapshots.length, 1);
  assert.equal(before.transform(input()), undefined);
  const after = h.current();
  for (const body of ["Continue here", "", "\n  preserve spaces  \n"]) {
    for (const ids of [{ messageId: "message-1" }, { clientMessageId: "client-message-1" }, { messageId: "message-1", clientMessageId: "client-message-1" }]) {
      const args = { item: { type: "user_message" as const, text: body, ...ids }, phase: "streaming" as const };
      const result = after.transform(args)!;
      assert.deepEqual(result.items[0]!.data, { histories: [`\n${history}\n`], body });
      assert.deepEqual(after.transform(args), result);
      (result.items[0]!.data.histories as string[]).push("mutated output");
      assert.equal(after.transform(args)!.items[0]!.data.histories.length, 1);
    }
  }
  assert.equal(after.transform(input("unknown")), undefined);
  assert.equal(after.transform({ item: { type: "user_message", text: "no identity" }, phase: "complete" }), undefined);
  assert.equal(after.transform(input("message-1", `${summary}\n\nbody`))!.items[0]!.data.histories.length, 1);
});

test("live canonical input wins over an in-flight stale refetch; the read is caught up again", async (t) => {
  const host = fakePaseo();
  const old = deferred<ReturnType<typeof page>>();
  const next = deferred<ReturnType<typeof page>>();
  host.setRead(async () => host.calls.length === 1 ? old.promise : next.promise);
  const h = harness(t, host);
  await tick();
  host.emit("agent-1", user("message-1", `${summary.replace("Previous answer", "fresh answer")}\n\nfresh`));
  old.resolve(page("agent-1", [user("message-1", `${summary}\n\nstale`)]));
  await settled();
  assert.equal(host.calls.length, 2);
  assert.equal(h.snapshots.length, 1);
  assert.match(h.current().transform(input())!.items[0]!.data.histories[0]!, /fresh answer/);
  next.resolve(page("agent-1", [user("message-1", `${summary.replace("Previous answer", "fresh answer")}\n\nfresh`)]));
  await settled();
  assert.equal(h.snapshots.length, 1, "an identical catch-up response does not re-register");
});

test("replacement and restored subscriptions clear old IDs and reject late results from the old epoch", async (t) => {
  const host = fakePaseo();
  host.setRead(async (id) => page(id, [user()]));
  const h = harness(t, host);
  await settled();
  assert.ok(h.current().transform(input()));
  const stale = deferred<ReturnType<typeof page>>();
  host.setRead(async () => stale.promise);
  host.event("agent-1", { type: "subscription_restored" });
  assert.equal(h.current().transform(input()), undefined, "invalidation is immediate");
  await tick();
  host.event("agent-1", { type: "replacement", epoch: "epoch-2" });
  host.setRead(async (id) => page(id, [user("message-2")], "epoch-2"));
  stale.resolve(page("agent-1", [user()], "epoch-1"));
  await settled();
  assert.equal(h.current().transform(input()), undefined);
  assert.ok(h.current().transform(input("message-2")));
  assert.equal(host.calls.length, 3);
});

test("directory snapshots, new agents, removal and late callbacks respect observation ownership", async (t) => {
  const host = fakePaseo();
  host.setRead(async (id) => page(id, [user(id)]));
  const h = harness(t, host);
  await settled();
  host.upsert("agent-2");
  await settled();
  assert.ok(h.current().transform(input("agent-2")));
  const stale = host.timelines.get("agent-2")!;
  host.remove("agent-2");
  assert.equal(h.current().transform(input("agent-2")), undefined);
  stale.handler({ agentId: "agent-2", event: { type: "timeline", item: user("late") } } as Parameters<typeof stale.handler>[0]);
  host.snapshot(["agent-3"]);
  await settled();
  assert.equal(h.current().transform(input("late")), undefined);
  assert.equal(stale.releases, 1);
  assert.equal(host.timelines.get("agent-1")!.releases, 1);
  const count = h.snapshots.length;
  await h.stop();
  host.emit("agent-3", user("after-stop"));
  host.upsert("after-stop");
  await settled();
  assert.equal(h.snapshots.length, count);
  assert.equal(host.timelines.has("after-stop"), false);
  assert.equal(host.directories[0]!.releases, 1);
  assert.equal(host.directories[0]!.unobserves, 1);
});

test("cleanup releases a late directory and ignores an outstanding timeline read", async (t) => {
  const lateHost = fakePaseo();
  const gate = deferred<void>();
  lateHost.setListGate(gate.promise);
  const late = harness(t, lateHost);
  await late.stop();
  gate.resolve();
  await tick();
  assert.equal(lateHost.directories[0]!.releases, 1);
  assert.equal(lateHost.timelines.size, 0);
  const host = fakePaseo();
  const read = deferred<ReturnType<typeof page>>();
  host.setRead(async () => read.promise);
  const h = harness(t, host);
  await tick();
  await h.stop();
  read.resolve(page("agent-1", [user()]));
  await settled();
  assert.equal(h.snapshots.length, 0);
  assert.equal(host.timelines.get("agent-1")!.releases, 1);
});

test("canonical paging is bounded and applies old pages before the newest page", async (t) => {
  const host = fakePaseo();
  host.setRead(async (id, options) => {
    const end = options.cursor?.seq ?? 500;
    const result = page(id, Array.from({ length: 100 }, (_, index) => user(`message-${end - 100 + index}`)));
    result.hasOlder = true;
    result.startCursor = { epoch: "epoch-1", seq: end - 100 };
    return result;
  });
  const h = harness(t, host);
  await settled();
  assert.equal(host.calls.length, 4);
  assert.equal(host.calls[1]!.options.direction, "before");
  assert.equal(h.snapshots.at(-1)!.length, 256);
  assert.equal(h.current().transform(input("message-100")), undefined);
  assert.ok(h.current().transform(input("message-499")));
});

test("agent and read concurrency limits also apply to newly created agents", async (t) => {
  const host = fakePaseo(Array.from({ length: 32 }, (_, index) => `agent-${index}`));
  const gate = deferred<ReturnType<typeof page>>();
  host.setRead(async (id) => ({ ...await gate.promise, agentId: id }));
  const h = harness(t, host);
  await tick();
  assert.equal(host.timelines.size, 32);
  assert.equal(host.calls.length, 4);
  host.upsert("new-agent");
  await tick();
  assert.equal([...host.timelines.values()].filter((entry) => entry.releases === 0).length, 32);
  assert.equal(host.calls.length, 4);
  gate.resolve(page("unused"));
  await settled();
  assert.ok(host.calls.some(({ id }) => id === "new-agent"));
  assert.equal(h.snapshots.length, 0);
});

test("oversized canonical messages and aggregate cache overflow fall back rather than truncating summaries", async (t) => {
  const h = harness(t);
  await tick();
  h.host.emit("agent-1", user("too-big", `${summary}${"x".repeat(1024 * 1024)}`));
  const large = `<chat-history-summary>${"x".repeat(900_000)}</chat-history-summary>`;
  for (let i = 0; i < 5; i++) h.host.emit("agent-1", user(`large-${i}`, large));
  await settled();
  assert.equal(h.current().transform(input("too-big")), undefined);
  assert.equal(h.current().transform(input("large-0")), undefined);
  assert.equal(h.current().transform(input("large-4"))!.items[0]!.data.histories[0]!.length, 900_000);
  assert.ok(h.snapshots.at(-1)!.reduce((sum, record) => sum + (record.histories?.join("").length ?? 0), 0) <= 4 * 1024 * 1024);
});

test("subscription/read failures retain native fallback and retry without agent reload", async (t) => {
  const h = harness(t);
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  await tick();
  h.host.event("agent-1", { type: "error", error: "disconnected" });
  assert.equal(h.current().transform(input()), undefined);
  h.host.setRead(async (id) => page(id, [user()]));
  await delay(1100);
  assert.equal(h.host.directories.length, 2);
  assert.ok(h.current().transform(input()));
  assert.equal(warnings.length, 1);
});

test("synchronous subscription failure releases its late handle and stops the rest of the directory snapshot", async (t) => {
  t.mock.method(console, "warn", () => {});
  const host = fakePaseo(["agent-1", "agent-2", "agent-3"]);
  host.failDuringSubscribe();
  const h = harness(t, host);
  await tick();
  assert.equal(host.timelines.size, 1);
  assert.equal(host.timelines.get("agent-3")!.releases, 1);
  assert.equal(host.directories[0]!.releases, 1);
  assert.equal(host.directories[0]!.unobserves, 1);
  assert.equal(host.calls.length, 0);
  await h.stop();
});

test("failed directory and canonical reads release ownership and recover through a new subscription", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const failure of ["directory", "read"] as const) {
    const host = fakePaseo();
    const directory = deferred<void>();
    if (failure === "directory") host.setListGate(directory.promise);
    else host.setRead(async () => { throw new Error("Read unavailable"); });
    const h = harness(t, host);
    if (failure === "directory") directory.reject(new Error("Directory unavailable"));
    await tick();
    assert.equal(h.current().transform(input()), undefined);
    if (failure === "read") {
      assert.equal(host.timelines.get("agent-1")!.releases, 1);
      assert.equal(host.directories[0]!.releases, 1);
    }
    host.setListGate(Promise.resolve());
    host.setRead(async (id) => page(id, [user()]));
    await delay(1100);
    assert.ok(h.current().transform(input()), `${failure} failure must allow a fresh backfill`);
    await h.stop();
  }
});

test("ID collisions, contradictory IDs and ordinary-message aliases never borrow another history", () => {
  const record: HistoryRecord = { agentId: "a", messageId: "m", clientMessageId: "c", histories: ["history"] };
  const transform = (records: HistoryRecord[], ids: { messageId?: string; clientMessageId?: string }) => createHistoryTransformer(records).transform({ item: { type: "user_message", text: "body", ...ids }, phase: "complete" });
  assert.equal(transform([record], { messageId: "different", clientMessageId: "c" }), undefined);
  assert.equal(transform([record, { ...record, agentId: "b" }], { messageId: "m" }), undefined);
  assert.equal(transform([record, { ...record, messageId: "m2" }], { clientMessageId: "c" }), undefined);
  assert.equal(transform([record, { ...record, histories: null }], { messageId: "m", clientMessageId: "c" }), undefined);
  assert.ok(transform([record, { ...record, messageId: undefined }], { messageId: "m", clientMessageId: "c" }));
  const original = { ...record, histories: ["original"] };
  const snapshot = createHistoryTransformer([original]);
  original.histories[0] = "changed";
  assert.equal(snapshot.transform({ item: { type: "user_message", text: "body", messageId: "m" }, phase: "complete" })!.items[0]!.data.histories[0], "original");
});
