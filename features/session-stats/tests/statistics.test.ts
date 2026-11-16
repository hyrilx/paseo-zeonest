import assert from "node:assert/strict";
import test from "node:test";
import { countInput, createCounter, createMeasurements, estimateTokens } from "../client/statistics";
import { createStatsStore, seconds, speed } from "../client/store";
import type { StreamEvent, TimelineItem } from "../client/types";

const provider = "pi";
const start = (turnId = "t"): StreamEvent => ({ type: "turn_started", provider, turnId });
const end = (turnId = "t"): StreamEvent => ({ type: "turn_completed", provider, turnId });
const text = (value: string, turnId = "t"): StreamEvent => ({ type: "timeline", provider, turnId, item: { type: "assistant_message", text: value } });
const tool = (callId: string, status: "running" | "completed" | "failed" | "canceled", turnId = "t"): StreamEvent => ({
  type: "timeline", provider, turnId, item: { type: "tool_call", callId, name: "test", status, error: null, detail: { type: "unknown", input: {}, output: {} } },
});

test("counts user rounds, model segments and unique tool calls, not streaming fragments or lifecycle updates", () => {
  const counter = createCounter();
  const add = (item: TimelineItem, turnId = "t") => { const input = countInput(item, turnId); if (input) counter.add(input); };
  add({ type: "user_message", messageId: "u", clientMessageId: "c", text: "question" });
  add({ type: "user_message", clientMessageId: "c", text: "echo" });
  add({ type: "reasoning", text: "think" });
  add({ type: "assistant_message", text: "a" });
  add({ type: "assistant_message", text: "b" });
  for (const id of ["a", "b"]) add((tool(id, "running") as Extract<StreamEvent, { type: "timeline" }>).item);
  add((tool("a", "completed") as Extract<StreamEvent, { type: "timeline" }>).item);
  add({ type: "assistant_message", text: "answer" });
  add((tool("b", "failed") as Extract<StreamEvent, { type: "timeline" }>).item);
  add({ type: "assistant_message", text: "more" });
  assert.deepEqual(counter.get(), { rounds: 1, steps: 2, tools: 2 });
  add({ type: "user_message", messageId: "u2", text: "next" }, "t2");
  for (const id of ["c", "d"]) add((tool(id, "completed") as Extract<StreamEvent, { type: "timeline" }>).item, "t2");
  add({ type: "assistant_message", text: "done" }, "t2");
  add({ type: "notification", level: "info", message: "notice" }, "t2");
  assert.deepEqual(counter.get(), { rounds: 2, steps: 4, tools: 4 });
  assert.equal(countInput({ type: "assistant_message", text: "" }), null);
});

test("estimated tokens use Unicode code points and retain fractional token increments", () => {
  assert.equal(estimateTokens("abcd中文あ한"), 5);
  assert.equal(estimateTokens("😀"), 0.25);
  assert.equal(estimateTokens(""), 0);
});

test("average TPS is total output tokens / total decoding time, never the arithmetic mean of segment rates", () => {
  const metrics = createMeasurements();
  metrics.add(start("one"), 0);
  metrics.add(text("a".repeat(40), "one"), 100);
  metrics.add(text("b".repeat(40), "one"), 1100);
  metrics.add(end("one"), 1200);
  metrics.add(start("two"), 2000);
  metrics.add(text("中".repeat(100), "two"), 2200);
  metrics.add(text("文".repeat(100), "two"), 4200);
  const live = metrics.get(4200);
  assert.equal(live.averageTps, 220 / 3);
  assert.notEqual(live.averageTps, (20 + 100) / 2);
  assert.deepEqual(metrics.get(4200), live); // Reads cannot re-add partial segments.
  metrics.add(end("two"), 4300);
  const result = metrics.get(9000);
  assert.equal(result.averageTps, 220 / 3);
  assert.equal(result.modelMs, 3500);
  assert.equal(result.toolMs, 0);
  assert.equal(result.ttftMs, 150);
  assert.equal(result.instantTps, null);
});

test("model total excludes the union of parallel tool time; tool total adds every call duration", () => {
  const metrics = createMeasurements();
  metrics.add(start(), 0);
  metrics.add(text("hello"), 100);
  metrics.add(tool("a", "running"), 300);
  metrics.add(tool("a", "running"), 350);
  metrics.add(tool("b", "running"), 400);
  assert.equal(metrics.get(600).modelMs, 300);
  assert.equal(metrics.get(600).toolMs, 500);
  metrics.add(tool("a", "completed"), 800);
  metrics.add(tool("a", "completed"), 900);
  metrics.add(tool("b", "failed"), 1000);
  metrics.add(text("again"), 1100);
  metrics.add(text("tail"), 1500);
  metrics.add(end(), 1600);
  assert.equal(metrics.get(1700).modelMs, 900);
  assert.equal(metrics.get(1700).toolMs, 1100);
  assert.equal(metrics.get(1700).ttftMs, 100);
});

test("permission waits are excluded, and an unmatched tool terminal does not invent a start time", () => {
  const metrics = createMeasurements();
  metrics.add(start(), 0);
  metrics.add({ type: "permission_requested", provider, request: { id: "p", provider, name: "ask", kind: "tool" } }, 100);
  metrics.add(tool("unseen", "completed"), 1000);
  metrics.add({ type: "permission_resolved", provider, requestId: "p", resolution: { behavior: "allow" } }, 1100);
  metrics.add(text("hello"), 1200);
  metrics.add(text("world"), 1300);
  metrics.add(end(), 1400);
  assert.equal(metrics.get(2000).modelMs, 400);
  assert.equal(metrics.get(2000).toolMs, 0);
  assert.equal(metrics.get(2000).ttftMs, 100);
});

test("failure and cancellation close clocks once; other turns and late terminal events are ignored", () => {
  for (const terminal of [
    { type: "turn_failed", provider, turnId: "t", error: "fail" },
    { type: "turn_canceled", provider, turnId: "t", reason: "stop" },
  ] satisfies StreamEvent[]) {
    const metrics = createMeasurements();
    metrics.add(start(), 0);
    metrics.add(start(), 50);
    metrics.add(tool("a", "running"), 100);
    metrics.add(text("wrong", "other"), 200);
    metrics.add(terminal, 300);
    metrics.add(terminal, 400);
    assert.equal(metrics.get(1000).modelMs, 100);
    assert.equal(metrics.get(1000).toolMs, 200);
    assert.equal(metrics.get(1000).ttftMs, null);
  }
});

test("mid-turn attachment and single-block responses do not fabricate speed or unknown timings", () => {
  const metrics = createMeasurements();
  metrics.add(text("already running"), 100);
  metrics.add(tool("x", "running"), 200);
  metrics.add(end(), 300);
  assert.deepEqual(metrics.get(300), { modelMs: null, toolMs: null, ttftMs: null, averageTps: null, instantTps: null });
  metrics.add(start(), 1000);
  metrics.add(text("one block"), 1500);
  metrics.add(end(), 2000);
  assert.equal(metrics.get(2000).ttftMs, 500);
  assert.equal(metrics.get(2000).averageTps, null);
  assert.equal(metrics.get(2000).instantTps, null);
});

test("instantaneous speed is a 3-second window, decays during a stall and clears during a tool/idle phase", () => {
  const metrics = createMeasurements();
  metrics.add(start(), 0);
  metrics.add(text("abcd"), 100);
  metrics.add(text("abcdefgh"), 1100);
  assert.equal(metrics.get(1100).instantTps, 2);
  assert.equal(metrics.get(2100).instantTps, 1);
  assert.equal(metrics.get(4100).instantTps, 0);
  metrics.add(tool("a", "running"), 4200);
  assert.equal(metrics.get(4200).instantTps, null);
  metrics.add(end(), 4300);
  assert.equal(metrics.get(5000).instantTps, null);
});

test("switching between 1/3/5-second windows retains samples and leaves weighted average unchanged", () => {
  const metrics = createMeasurements();
  metrics.add(start(), 0);
  for (const now of [100, 1100, 2100, 3100, 4100]) metrics.add(text("abcd"), now);
  assert.equal(metrics.get(5100, 1000).instantTps, 0);
  assert.equal(metrics.get(5100, 3000).instantTps, 2 / 3);
  assert.equal(metrics.get(5100, 5000).instantTps, 4 / 5);
  assert.equal(metrics.get(5100, 1000).averageTps, 5 / 4);
  assert.equal(metrics.get(5100, 5000).averageTps, 5 / 4);
  metrics.add(text("abcd"), 6100);
  assert.equal(metrics.get(6100, 5000).instantTps, 4 / 5);
  assert.equal(metrics.get(6100, 1000).instantTps, 1);
});

test("store snapshots are stable and formatting distinguishes zero from missing data", () => {
  const source = createStatsStore();
  let calls = 0;
  const unsubscribe = source.subscribe(() => calls++);
  const initial = source.get();
  source.set({ ...initial });
  assert.equal(source.get(), initial);
  assert.equal(calls, 0);
  source.set({ ...initial, tools: 1 });
  assert.equal(calls, 1);
  unsubscribe();
  source.set({ ...initial, tools: 2 });
  assert.equal(calls, 1);
  assert.equal(speed(null), "未采集");
  assert.equal(speed(0), "≈ 0.0 tok/s");
  assert.equal(speed(208), "≈ 208 tok/s");
  assert.equal(seconds(1500), "≈ 1.5 秒");
  assert.equal(seconds(null), "未采集");
});
