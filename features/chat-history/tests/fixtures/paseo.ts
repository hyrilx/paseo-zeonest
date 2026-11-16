import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { HistoryUserMessage } from "../../client/transform";

type Paseo = PluginClientContext["paseo"];
type Agent = ReturnType<Paseo["agents"]["ref"]>;
export type TimelineEvent = Parameters<Parameters<Agent["timeline"]["subscribe"]>[0]>[0];
export type ReadOptions = NonNullable<Parameters<Agent["timeline"]["refetch"]>[0]>;
export type ReadResult = Awaited<ReturnType<Agent["timeline"]["refetch"]>>;
type ListResult = Awaited<ReturnType<Paseo["agents"]["list"]>>;
type Observer = Parameters<NonNullable<ListResult["subscription"]>["subscribe"]>[0];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const history = "Source agent: Example\n[User] Previous question\n[Assistant] Previous answer";
export const summary = `<chat-history-summary>\n${history}\n</chat-history-summary>`;
export function user(id = "message-1", text = `${summary}\n\nContinue here`): HistoryUserMessage {
  return { type: "user_message", messageId: id, clientMessageId: `client-${id}`, text };
}
export function page(agentId: string, items: HistoryUserMessage[] = [], epoch = "epoch-1"): ReadResult {
  return {
    agentId, agent: null, requestId: "test", direction: "tail", projection: "canonical", epoch,
    reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
    startCursor: { epoch, seq: 1 }, endCursor: { epoch, seq: 1 }, hasOlder: false, hasNewer: false, error: null,
    entries: items.map((item, index) => ({ provider: "test", item, timestamp: "2026-01-01T00:00:00.000Z", seqStart: index + 1, seqEnd: index + 1, sourceSeqRanges: [], collapsed: [] })),
  };
}

export function fakePaseo(initialIds = ["agent-1"]) {
  const calls: { id: string; options: ReadOptions }[] = [];
  const timelines = new Map<string, { handler: (event: TimelineEvent) => void; releases: number; ready: ReturnType<typeof deferred<void>> }>();
  const directories: { observer?: Observer; releases: number; unobserves: number }[] = [];
  let ids = initialIds;
  let autoReady = true;
  let synchronousError = false;
  let read: (id: string, options: ReadOptions) => Promise<ReadResult> = async (id) => page(id);
  let listGate: Promise<void> | undefined;
  const snapshot = () => ({ entries: ids.map((id) => ({ agent: { id, archivedAt: null } })), subscriptionId: "directory-test" }) as Parameters<Observer["snapshot"]>[0];
  const paseo = {
    agents: {
      async list(_options: Parameters<Paseo["agents"]["list"]>[0]) {
        if (listGate) await listGate;
        const directory: (typeof directories)[number] = { releases: 0, unobserves: 0 };
        directories.push(directory);
        const subscription = {
          ready: Promise.resolve(snapshot()),
          subscribe(observer: Observer) {
            directory.observer = observer;
            observer.snapshot(snapshot());
            return () => { directory.unobserves++; };
          },
          async release() { directory.releases++; },
        };
        return { ...snapshot(), subscription } as unknown as ListResult;
      },
      ref(id: string) {
        return { timeline: {
          subscribe(handler: (event: TimelineEvent) => void) {
            const timeline = { handler, releases: 0, ready: deferred<void>() };
            timelines.set(id, timeline);
            if (autoReady) timeline.ready.resolve();
            if (synchronousError) {
              synchronousError = false;
              handler({ agentId: id, event: { type: "error", error: "Subscription unavailable" } } as TimelineEvent);
            }
            const subscription = () => { timeline.releases++; };
            subscription.ready = timeline.ready.promise;
            subscription.release = async () => { timeline.releases++; };
            return subscription;
          },
          async refetch(options: ReadOptions) { calls.push({ id, options }); return read(id, options); },
          async append() { throw new Error("Unexpected timeline write"); },
        }, reload() { throw new Error("Unexpected agent reload"); } };
      },
    },
  } as unknown as Paseo;
  return {
    paseo, calls, timelines, directories,
    setRead(value: typeof read) { read = value; },
    setReady(value: boolean) { autoReady = value; },
    failDuringSubscribe() { synchronousError = true; },
    setListGate(value: Promise<void>) { listGate = value; },
    snapshot(value: string[]) { ids = value; directories.at(-1)!.observer!.snapshot(snapshot()); },
    upsert(id: string, archivedAt: string | null = null) {
      directories.at(-1)!.observer!.update({ type: "agent_update", payload: { kind: "upsert", agent: { id, archivedAt } } } as Parameters<Observer["update"]>[0]);
    },
    remove(id: string) { directories.at(-1)!.observer!.update({ type: "agent_update", payload: { kind: "remove", agentId: id } }); },
    emit(id: string, item: HistoryUserMessage, epoch = "epoch-1") {
      timelines.get(id)!.handler({ agentId: id, epoch, event: { type: "timeline", item }, timestamp: "2026-01-01T00:00:00.000Z" } as TimelineEvent);
    },
    event(id: string, event: TimelineEvent["event"]) {
      timelines.get(id)!.handler({ agentId: id, event } as TimelineEvent);
    },
  };
}
