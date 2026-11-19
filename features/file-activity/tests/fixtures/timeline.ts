import type { Agent, TimelineItem, TimelineMessage, TimelinePage, ToolItem, RecordEntry } from "../../client/types";

export function tool(callId: string, detail: ToolItem["detail"], status: ToolItem["status"] = "completed", name: string = detail.type): ToolItem {
  if (status === "failed") return { type: "tool_call", callId, detail, name, status, error: { message: "test failure" } };
  return { type: "tool_call", callId, detail, name, status, error: null };
}
export function record(item: TimelineItem, seq: number, turnId?: string): RecordEntry {
  return { item, seq, turnId, timestamp: "2026-01-01T00:00:00.000Z" };
}
export function user(seq: number, turnId?: string, text = "处理文件") {
  return record({ type: "user_message", text, messageId: "m" + seq }, seq, turnId);
}
export const unknown = (callId: string, name: string, input: unknown, output: unknown = {}) => tool(callId, { type: "unknown", input, output }, "completed", name);
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function page(records: RecordEntry[] = [], overrides: Partial<TimelinePage> = {}): TimelinePage {
  return { agentId: "a", agent: null, requestId: "r", direction: "tail", projection: "canonical", epoch: "e", reset: false, staleCursor: false, gap: false,
    window: { minSeq: 0, maxSeq: records.at(-1)?.seq ?? 0, nextSeq: 1 },
    startCursor: records.length ? { epoch: "e", seq: records[0]!.seq } : null, endCursor: null, hasOlder: false, hasNewer: false, error: null,
    entries: records.map((entry) => ({ item: entry.item, turnId: entry.turnId ?? undefined, timestamp: entry.timestamp!, provider: "pi", seqStart: entry.seq, seqEnd: entry.updatedSeq ?? entry.seq,
      sourceSeqRanges: [{ startSeq: entry.seq, endSeq: entry.updatedSeq ?? entry.seq }], collapsed: [] })), ...overrides };
}
export function stream(entry: RecordEntry, epoch = "e"): TimelineMessage {
  return { agentId: "a", epoch, seq: entry.seq, timestamp: entry.timestamp!, event: { type: "timeline", provider: "pi", item: entry.item, turnId: entry.turnId } } as TimelineMessage;
}
export function fakeAgent() {
  const handlers: ((message: TimelineMessage) => void)[] = [];
  const calls: unknown[] = [];
  let releases = 0;
  let release: () => Promise<void> = async () => {};
  let ready = Promise.resolve();
  let read: (options: Parameters<Agent["timeline"]["refetch"]>[0]) => Promise<TimelinePage> = async () => page();
  const agent = { id: "a", timeline: {
    subscribe(handler: (message: TimelineMessage) => void) { handlers.push(handler); return Object.assign(() => {}, { ready, async release() { releases++; await release(); } }); },
    async refetch(options: Parameters<Agent["timeline"]["refetch"]>[0]) { calls.push(options); return read(options); },
  } } as Agent;
  return { agent, handlers, calls, get releases() { return releases; },
    setRead(value: typeof read) { read = value; }, setReady(value: Promise<void>) { ready = value; },
    setRelease(value: typeof release) { release = value; },
    emit(message: TimelineMessage) { handlers.at(-1)?.(message); } };
}
export const flush = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
