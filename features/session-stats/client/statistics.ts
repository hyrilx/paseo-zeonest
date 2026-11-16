import type { Counts, Measurements, StreamEvent, TimelineItem } from "./types";

export const WINDOW_MS = 3000;
const MAX_WINDOW_MS = 5000;
const MAX_IDENTITIES = 4096;

// Keep identities and structural signals only; never retain chat/tool contents.
export interface CountInput {
  type: "user" | "output" | "tool";
  id?: string;
  alias?: string;
  turnId?: string;
}
export function countInput(item: TimelineItem, turnId?: string): CountInput | null {
  if (item.type === "user_message") return { type: "user", id: item.messageId, alias: item.clientMessageId, turnId };
  if ((item.type === "assistant_message" || item.type === "reasoning") && item.text.length) return { type: "output", turnId };
  if (item.type === "tool_call") return { type: "tool", id: item.callId, turnId };
  return null;
}
function remember(set: Set<string>, id: string) {
  set.add(id);
  if (set.size > MAX_IDENTITIES) set.delete(set.values().next().value!);
}
export function createCounter() {
  const counts: Counts = { rounds: 0, steps: 0, tools: 0 };
  const users = new Set<string>();
  const tools = new Set<string>();
  let phase: "none" | "model" | "tools" = "none";
  let turn: string | undefined;
  return {
    get: (): Counts => ({ ...counts }),
    add(input: CountInput) {
      if (input.turnId && turn !== input.turnId) { phase = "none"; turn = input.turnId; }
      if (input.type === "user") {
        const keys = [input.id, input.alias].filter((key): key is string => !!key);
        const seen = keys.some((key) => users.has(key));
        for (const key of keys) remember(users, key);
        if (seen) return;
        counts.rounds++;
        phase = "none";
      } else if (input.type === "output") {
        if (phase !== "model") counts.steps++;
        phase = "model";
      } else if (input.id && !tools.has(input.id)) {
        remember(tools, input.id);
        counts.tools++;
        if (phase === "none") counts.steps++;
        phase = "tools";
      }
    },
  };
}

// Heuristic, not a tokenizer: one CJK code point/token, four other code points/token.
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const point of text) tokens += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(point) ? 1 : 0.25;
  return tokens;
}
interface Segment {
  started: number;
  first: number | null;
  last: number | null;
  tokens: number;
}
interface Turn {
  id?: string;
  segment: Segment | null;
  tools: Map<string, number>;
  permissions: Set<string>;
  seenTools: Set<string>;
  samples: { time: number; tokens: number }[];
}

// All timings use a monotonic client clock. History is deliberately excluded.
export function createMeasurements() {
  let turn: Turn | null = null;
  let modelMs = 0;
  let toolMs = 0;
  let modelObserved = false;
  let observedTurn = false;
  let ttftSum = 0;
  let ttftCount = 0;
  let outputTokens = 0;
  let outputMs = 0;

  function finishSegment(now: number) {
    if (!turn?.segment) return;
    const segment = turn.segment;
    modelMs += Math.max(0, now - segment.started);
    modelObserved = true;
    if (segment.first !== null && segment.last !== null && segment.last > segment.first) {
      outputTokens += segment.tokens;
      outputMs += segment.last - segment.first;
    }
    turn.segment = null;
    turn.samples = [];
  }
  function resume(now: number) {
    if (turn && !turn.segment && !turn.tools.size && !turn.permissions.size) {
      turn.segment = { started: now, first: null, last: null, tokens: 0 };
    }
  }
  function finish(now: number) {
    if (!turn) return;
    finishSegment(now);
    for (const started of turn.tools.values()) toolMs += Math.max(0, now - started);
    turn = null;
  }
  return {
    add(event: StreamEvent, now: number) {
      now = Math.floor(now);
      if (event.type === "turn_started") {
        if (turn && turn.id === event.turnId) return;
        finish(now);
        observedTurn = true;
        turn = { id: event.turnId, segment: { started: now, first: null, last: null, tokens: 0 }, tools: new Map(), permissions: new Set(), seenTools: new Set(), samples: [] };
        return;
      }
      if (!turn || ("turnId" in event && event.turnId && turn.id && event.turnId !== turn.id)) return;
      if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled") { finish(now); return; }
      if (event.type === "permission_requested") {
        finishSegment(now);
        turn.permissions.add(event.request.id);
      } else if (event.type === "permission_resolved") {
        turn.permissions.delete(event.requestId);
        resume(now);
      } else if (event.type === "timeline") {
        const item = event.item;
        if (item.type === "tool_call") {
          if (item.status === "running" && !turn.seenTools.has(item.callId)) {
            finishSegment(now);
            remember(turn.seenTools, item.callId);
            turn.tools.set(item.callId, now);
          } else if (item.status !== "running" && turn.tools.has(item.callId)) {
            toolMs += Math.max(0, now - turn.tools.get(item.callId)!);
            turn.tools.delete(item.callId);
            resume(now);
          }
        } else if ((item.type === "assistant_message" || item.type === "reasoning") && item.text.length && turn.segment) {
          const segment = turn.segment;
          const tokens = estimateTokens(item.text);
          segment.tokens += tokens;
          if (segment.first === null) {
            segment.first = now;
            ttftSum += Math.max(0, now - segment.started);
            ttftCount++;
            // Instantaneous speed uses the first chunk as its time baseline.
            // Weighted average includes ALL tokens of every measurable segment.
            turn.samples = [{ time: now, tokens: 0 }];
          } else {
            turn.samples.push({ time: now, tokens });
            // Aggregate bursts per millisecond; retain at most the largest selectable window.
            const last = turn.samples.length - 1;
            if (last > 0 && turn.samples[last - 1]!.time === now) {
              turn.samples[last - 1]!.tokens += tokens;
              turn.samples.pop();
            }
          }
          segment.last = now;
          while (turn.samples.length > 1 && turn.samples[1]!.time < now - MAX_WINDOW_MS) turn.samples.shift();
        }
      }
    },
    get(now: number, windowMs = WINDOW_MS): Measurements {
      now = Math.floor(now);
      let currentModel = modelMs;
      let currentTools = toolMs;
      let tokens = outputTokens;
      let duration = outputMs;
      let instantTps: number | null = null;
      if (turn) {
        for (const started of turn.tools.values()) currentTools += Math.max(0, now - started);
        const segment = turn.segment;
        if (segment) {
          currentModel += Math.max(0, now - segment.started);
          if (segment.first !== null && segment.last !== null && segment.last > segment.first) {
            tokens += segment.tokens;
            duration += segment.last - segment.first;
          }
          if (segment.first !== null && segment.last !== null && segment.last > segment.first) {
            const start = Math.max(segment.first, now - windowMs);
            const elapsed = now - start;
            // Use a fixed rolling window after warm-up; stale text decays to zero.
            const recent = turn.samples.filter((sample) => sample.time > start);
            if (elapsed >= 100) instantTps = recent.reduce((sum, sample) => sum + sample.tokens, 0) * 1000 / elapsed;
          }
        }
      }
      return {
        modelMs: modelObserved || turn?.segment ? currentModel : null,
        toolMs: observedTurn ? currentTools : null,
        ttftMs: ttftCount ? ttftSum / ttftCount : null,
        averageTps: duration > 0 ? tokens * 1000 / duration : null,
        instantTps,
      };
    },
  };
}
