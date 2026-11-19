import { mergeRecords } from "./activity";
import type { Agent, RecordEntry, TimelineMessage, TimelinePage } from "./types";

export interface TimelineState {
  records: RecordEntry[];
  status: "loading" | "ready" | "error";
  partial: boolean;
  warning: string;
}
export function createTimelineStore() {
  let state: TimelineState = { records: [], status: "loading", partial: false, warning: "" };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: TimelineState) { state = next; for (const listener of listeners) listener(); },
  };
}
export type TimelineStore = ReturnType<typeof createTimelineStore>;
const relevant = (entry: RecordEntry) => entry.item.type === "tool_call" || entry.item.type === "user_message";

export function observeTimeline(agent: Agent, maxEntries: number, source: TimelineStore) {
  let stopped = false;
  let observation = 0;
  let generation = 0;
  let ready = false;
  let loading = true;
  let fetching = false;
  let requested = false;
  let epoch: string | null = null;
  let lastSeq = -1;
  let partial = false;
  let records: RecordEntry[] = [];
  let buffer: RecordEntry[] = [];
  let subscription: ReturnType<Agent["timeline"]["subscribe"]> | undefined;
  const releases = new Set<Promise<void>>();
  function release() {
    if (!subscription) return;
    const current = subscription; subscription = undefined;
    const task = Promise.resolve().then(() => current.release()).catch(() => { console.warn("[file-activity] Could not release timeline subscription."); });
    releases.add(task); void task.then(() => releases.delete(task));
  }
  function publish(status: TimelineState["status"], warning = "") {
    if (!stopped) source.set({ records, status, partial, warning: warning || (partial ? "仅显示已加载记录：历史缺页、记录无序号或已达到数量上限。轮号按已加载消息编排。" : "") });
  }
  function fail() {
    generation++; ready = false; observation++; requested = false; partial = true;
    release(); publish("error", "文件活动读取失败，已有记录可能不完整。请重新读取。");
  }
  function invalidate(nextEpoch: string | null = null) {
    generation++; epoch = nextEpoch; loading = true; records = []; buffer = []; lastSeq = -1; partial = false;
    publish("loading"); requested = true; pump();
  }
  async function fetchHistory(version: number) {
    let cursor: TimelinePage["startCursor"] = null;
    let history: RecordEntry[] = [];
    let high = -1;
    let count = 0;
    let capped = false;
    while (true) {
      const page = await agent.timeline.refetch({ direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: 100, projection: "canonical" });
      if (stopped || version !== generation) return;
      if (page.error || page.agentId !== agent.id) throw new Error("Invalid file activity timeline response");
      if (epoch !== null && epoch !== page.epoch) { invalidate(page.epoch); return; }
      epoch = page.epoch;
      if (page.gap || page.staleCursor) throw new Error("File activity timeline has a gap");
      high = Math.max(high, ...page.entries.map((entry) => entry.seqEnd));
      history.push(...page.entries.map((entry) => ({ item: entry.item, turnId: entry.turnId ?? undefined, seq: entry.seqStart, updatedSeq: entry.seqEnd, timestamp: entry.timestamp })).filter(relevant));
      count += page.entries.length;
      if (!page.hasOlder) break;
      if (count >= maxEntries || !page.startCursor || (cursor && page.startCursor.seq >= cursor.seq) || page.startCursor.epoch !== epoch) { capped = true; break; }
      cursor = page.startCursor;
    }
    if (stopped || version !== generation) return;
    records = mergeRecords([...history, ...buffer.filter((entry) => entry.unsequenced || (entry.updatedSeq ?? entry.seq) > high)]);
    if (records.length > maxEntries) { records = records.slice(-maxEntries); capped = true; }
    buffer = []; lastSeq = Math.max(lastSeq, high); partial ||= capped; loading = false;
    publish("ready");
  }
  function pump() {
    if (stopped || !ready || fetching || !requested) return;
    requested = false; fetching = true;
    const version = generation;
    void fetchHistory(version).catch(() => { if (!stopped && generation === version) fail(); }).finally(() => { fetching = false; pump(); });
  }
  function receive(message: TimelineMessage) {
    if (stopped || message.agentId !== agent.id) return;
    const event = message.event;
    if (event.type === "error") { fail(); return; }
    if (event.type === "replacement" || event.type === "subscription_restored") { invalidate(event.type === "replacement" ? event.epoch : null); return; }
    if (event.type !== "timeline") return;
    const messageEpoch = "epoch" in message ? message.epoch : undefined;
    const seq = "seq" in message ? message.seq : undefined;
    if (messageEpoch && epoch !== null && messageEpoch !== epoch) invalidate(messageEpoch);
    else if (messageEpoch) epoch = messageEpoch;
    if (seq !== undefined && seq <= lastSeq) return;
    if (seq !== undefined) lastSeq = seq;
    else partial = true;
    const entry: RecordEntry = { item: event.item, turnId: event.turnId, timestamp: "timestamp" in message ? message.timestamp : undefined,
      seq: seq ?? lastSeq + 0.5, unsequenced: seq === undefined };
    if (!relevant(entry)) return;
    if (loading) {
      buffer.push(entry);
      if (buffer.length > maxEntries) { buffer.shift(); partial = true; }
    } else {
      records = mergeRecords([...records, entry]);
      if (records.length > maxEntries) { records = records.slice(-maxEntries); partial = true; }
      publish("ready");
    }
  }
  function attach() {
    if (stopped) return;
    release(); ready = false;
    const attempt = ++observation;
    invalidate();
    try {
      const value = agent.timeline.subscribe((message) => { if (attempt === observation) receive(message); });
      if (stopped || attempt !== observation) { void value.release().catch(() => {}); return; }
      subscription = value;
      void value.ready.then(() => { if (!stopped && attempt === observation) { ready = true; pump(); } })
        .catch(() => { if (!stopped && attempt === observation) fail(); });
    } catch { fail(); }
  }
  attach();
  return { retry: attach, async stop() { stopped = true; generation++; observation++; requested = false; records = []; buffer = []; release(); await Promise.allSettled([...releases]); } };
}
