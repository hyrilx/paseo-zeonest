import assert from "node:assert/strict";
import test from "node:test";
import { createTimelineStore, observeTimeline } from "../client/timeline";
import { projectActivity } from "../client/activity";
import { deferred, fakeAgent, flush, page, record, stream, tool, user } from "./fixtures/timeline";
import type { TimelinePage } from "../client/types";

const read = (id: string, seq: number, turn = "t") => record(tool(id, { type: "read", filePath: id }), seq, turn);
test("waits for subscription readiness, pages history backwards and merges live lifecycle updates", async () => {
  const host = fakeAgent(); const ready = deferred<void>(); host.setReady(ready.promise);
  const tail = deferred<TimelinePage>();
  host.setRead(async (options) => options?.direction === "before" ? page([user(1, "t"), read("r", 2)]) : tail.promise);
  const source = createTimelineStore(); const observer = observeTimeline(host.agent, 5000, source);
  await flush(); assert.equal(host.calls.length, 0);
  ready.resolve(); await flush(); assert.equal(host.calls.length, 1);
  host.emit(stream(record(tool("r", { type: "read", filePath: "r", content: "new" }), 6, "t")));
  tail.resolve(page([read("x", 5)], { hasOlder: true })); await flush();
  assert.equal(host.calls.length, 2);
  assert.equal(source.get().status, "ready");
  const activities = projectActivity(source.get().records).activities;
  assert.equal(activities.length, 2);
  assert.equal(activities.find((item) => item.callId === "r")!.content, "new");
  host.emit(stream(read("x", 5))); assert.equal(projectActivity(source.get().records).activities.length, 2);
  await observer.stop(); assert.equal(host.releases, 1);
});
test("replacement discards old generations and serializes refetch before publishing new epoch", async () => {
  const host = fakeAgent(); const old = deferred<TimelinePage>();
  host.setRead(async () => old.promise);
  const source = createTimelineStore(); const observer = observeTimeline(host.agent, 5000, source);
  await flush();
  host.emit({ agentId: "a", event: { type: "replacement", epoch: "e2" } });
  host.setRead(async () => page([read("new", 2)], { epoch: "e2" }));
  old.resolve(page([read("old", 1)])); await flush();
  assert.equal(host.calls.length, 2);
  assert.deepEqual(projectActivity(source.get().records).activities.map((item) => item.path), ["new"]);
  await observer.stop();
});
test("subscription restore refetches missed events; transport error releases and manual retry reattaches", async () => {
  const host = fakeAgent(); host.setRead(async () => page([read("old", 1)]));
  const source = createTimelineStore(); const observer = observeTimeline(host.agent, 5000, source);
  await flush();
  host.setRead(async () => page([read("missed", 3)]));
  host.emit({ agentId: "a", subscriptionId: "s", event: { type: "subscription_restored" } }); await flush();
  assert.equal(source.get().records[0]!.seq, 3);
  host.emit({ agentId: "a", event: { type: "error", error: "offline" } }); await flush();
  assert.equal(source.get().status, "error"); assert.equal(host.releases, 1);
  observer.retry(); await flush(); assert.equal(source.get().status, "ready");
  const seq = source.get().records[0]!.seq;
  host.handlers[0]!(stream(read("stale", 99)));
  assert.equal(source.get().records[0]!.seq, seq);
  await observer.stop(); assert.equal(host.releases, 2);
});
test("gaps, stale cursors and wrong-agent pages are errors rather than silently complete history", async () => {
  for (const overrides of [{ gap: true }, { staleCursor: true }, { agentId: "wrong" }, { error: "missing" }]) {
    const host = fakeAgent(); host.setRead(async () => page([], overrides));
    const source = createTimelineStore(); const observer = observeTimeline(host.agent, 5000, source);
    await flush(); assert.equal(source.get().status, "error");
    assert.equal(source.get().partial, true); await observer.stop();
  }
});
test("cap, non-progressing cursor and missing live sequence mark partial", async () => {
  const host = fakeAgent(); host.setRead(async () => page([read("a", 3)], { hasOlder: true }));
  const source = createTimelineStore(); const observer = observeTimeline(host.agent, 1, source);
  await flush(); assert.equal(host.calls.length, 1); assert.equal(source.get().partial, true);
  const message = stream(read("b", 4)); if ("seq" in message) delete message.seq;
  host.emit(message); assert.equal(source.get().records.length, 1); assert.equal(source.get().partial, true);
  await observer.stop();
  const stuck = fakeAgent(); stuck.setRead(async () => page([read("x", 5)], { hasOlder: true }));
  const next = createTimelineStore(); const another = observeTimeline(stuck.agent, 5000, next);
  await flush(); assert.equal(stuck.calls.length, 2); assert.equal(next.get().partial, true);
  await another.stop();
});
test("cleanup blocks late history, late subscription readiness and callbacks", async () => {
  for (const stage of ["ready", "history"]) {
    const host = fakeAgent(); const ready = deferred<void>(); const history = deferred<TimelinePage>();
    if (stage === "ready") host.setReady(ready.promise);
    host.setRead(async () => history.promise);
    const source = createTimelineStore(); const observer = observeTimeline(host.agent, 5000, source);
    await flush(); await observer.stop();
    const initial = source.get();
    ready.resolve(); history.resolve(page([read("late", 1)])); host.emit(stream(read("late", 2))); await flush();
    assert.equal(source.get(), initial); assert.equal(host.releases, 1);
  }
});
test("ready rejection and synchronous subscribe failure expose retry state", async () => {
  const host = fakeAgent(); const ready = deferred<void>(); host.setReady(ready.promise);
  const source = createTimelineStore(); const observer = observeTimeline(host.agent, 5000, source);
  ready.reject(new Error("offline")); await flush(); assert.equal(source.get().status, "error");
  await observer.stop();
  host.agent.timeline.subscribe = () => { throw new Error("offline"); };
  const again = observeTimeline(host.agent, 5000, source);
  assert.equal(source.get().status, "error"); await again.stop();
});
