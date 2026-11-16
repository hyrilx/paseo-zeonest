import type { PluginClientContext } from "@getpaseo/plugin/client";
import { splitHistoryMessage } from "./parse";
import type { HistoryRecord, HistoryUserMessage } from "./transform";

type Paseo = PluginClientContext["paseo"];
type Agent = ReturnType<Paseo["agents"]["ref"]>;
type Subscription = ReturnType<Agent["timeline"]["subscribe"]>;
type Directory = Awaited<ReturnType<Paseo["agents"]["list"]>>["subscription"];
type TimelineMessage = Parameters<Parameters<Agent["timeline"]["subscribe"]>[0]>[0];

const MAX_AGENTS = 32;
const MAX_RECORDS = 256;
const MAX_MESSAGE_CHARS = 1024 * 1024;
const MAX_CACHE_CHARS = 4 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const MAX_READS = 4;
const BATCH_MS = 30;

interface Watch {
  id: string;
  agent: Agent;
  subscription?: Subscription;
  ready: boolean;
  epoch: string | null;
  generation: number;
  revision: number;
  fetching: boolean;
  again: boolean;
}

// Only public SDK reads/subscriptions are used. No provider reload or UI-store writes.
export function observeHistory(paseo: Paseo, publish: (records: readonly HistoryRecord[]) => void): () => Promise<void> {
  const watches = new Map<string, Watch>();
  const records = new Map<string, { record: HistoryRecord; chars: number }>();
  const pending = new Set<Watch>();
  const releases = new Set<Promise<void>>();
  let cacheChars = 0;
  let reads = 0;
  let stopped = false;
  let batch: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let directory: Directory;
  let unobserve: (() => void) | undefined;
  let attempt: AbortController | undefined;

  const active = (watch: Watch) => !stopped && watches.get(watch.id) === watch;
  const release = (value: { release(): Promise<void> } | undefined) => {
    if (!value) return;
    const task = Promise.resolve().then(() => value.release()).catch(() => {
      console.warn("[chat-history] Could not release a history subscription.");
    });
    releases.add(task);
    void task.then(() => releases.delete(task));
  };
  const flush = () => {
    if (batch !== undefined) clearTimeout(batch);
    batch = undefined;
    if (!stopped) publish([...records.values()].map(({ record }) => record));
  };
  const changed = () => { if (batch === undefined && !stopped) batch = setTimeout(flush, BATCH_MS); };
  const clearRecords = (agentId: string) => {
    let removed = false;
    for (const [key, value] of records) {
      if (value.record.agentId !== agentId) continue;
      records.delete(key);
      cacheChars -= value.chars;
      removed = true;
    }
    return removed;
  };
  const remember = (agentId: string, item: HistoryUserMessage) => {
    if (!item.messageId && !item.clientMessageId) return;
    const key = JSON.stringify([agentId, item.messageId, item.clientMessageId]);
    const histories = item.text.length <= MAX_MESSAGE_CHARS ? splitHistoryMessage(item.text)?.histories ?? null : null;
    const record: HistoryRecord = { agentId, messageId: item.messageId, clientMessageId: item.clientMessageId, histories };
    const previous = records.get(key);
    if (previous && JSON.stringify(previous.record) === JSON.stringify(record)) return;
    if (previous) { records.delete(key); cacheChars -= previous.chars; }
    const chars = key.length + (histories?.reduce((sum, text) => sum + text.length, 0) ?? 0);
    if (chars > MAX_CACHE_CHARS) return;
    records.set(key, { record, chars });
    cacheChars += chars;
    while (records.size > MAX_RECORDS || cacheChars > MAX_CACHE_CHARS) {
      const oldest = records.entries().next().value!;
      records.delete(oldest[0]);
      cacheChars -= oldest[1].chars;
    }
    changed();
  };
  const forget = (watch: Watch) => {
    watches.delete(watch.id);
    pending.delete(watch);
    release(watch.subscription);
    if (clearRecords(watch.id)) changed();
  };
  const invalidate = (watch: Watch, epoch: string | null) => {
    watch.epoch = epoch;
    watch.generation++;
    watch.revision++;
    // Invalidate published IDs immediately, before an old response can arrive.
    if (clearRecords(watch.id)) flush();
  };
  const reset = () => {
    attempt?.abort();
    attempt = undefined;
    unobserve?.();
    unobserve = undefined;
    release(directory);
    directory = undefined;
    for (const watch of watches.values()) forget(watch);
    flush();
  };
  const recover = () => {
    if (stopped || retry !== undefined) return;
    console.warn("[chat-history] History backfill unavailable; unmatched messages stay native. Retrying.");
    reset();
    retry = setTimeout(() => { retry = undefined; void start(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
  const request = (watch: Watch) => {
    if (!active(watch) || !watch.ready) return;
    if (watch.fetching) { watch.again = true; return; }
    pending.add(watch);
    pump();
  };
  const fetchHistory = async (watch: Watch) => {
    const generation = watch.generation;
    const revision = watch.revision;
    let cursor: Awaited<ReturnType<Agent["timeline"]["refetch"]>>["startCursor"] = null;
    const pages: HistoryUserMessage[][] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await watch.agent.timeline.refetch({
        direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE, projection: "canonical",
      });
      if (!active(watch)) return;
      if (generation !== watch.generation || revision !== watch.revision) { watch.again = true; return; }
      if (response.agentId !== watch.id || response.error) throw new Error("Invalid history response");
      if (watch.epoch !== null && response.epoch !== watch.epoch) {
        invalidate(watch, response.epoch);
        watch.again = true;
        return;
      }
      watch.epoch = response.epoch;
      pages.push(response.entries.flatMap(({ item }) => item.type === "user_message" ? [item] : []));
      retryDelay = 1000;
      if (!response.hasOlder || !response.startCursor) break;
      if (cursor && cursor.epoch === response.startCursor.epoch && cursor.seq === response.startCursor.seq) break;
      cursor = response.startCursor;
    }
    // Apply oldest pages first so bounded eviction keeps the newest messages.
    for (const page of pages.reverse()) for (const item of page) remember(watch.id, item);
  };
  function pump() {
    if (stopped) return;
    while (reads < MAX_READS && pending.size) {
      const watch = pending.values().next().value!;
      pending.delete(watch);
      if (!active(watch)) continue;
      watch.fetching = true;
      watch.again = false;
      reads++;
      void fetchHistory(watch).catch(() => { if (active(watch)) recover(); }).finally(() => {
        reads--;
        watch.fetching = false;
        if (watch.again) request(watch);
        pump();
      });
    }
  }
  const receive = (watch: Watch, message: TimelineMessage) => {
    if (!active(watch) || message.agentId !== watch.id) return;
    const { event } = message;
    if (event.type === "error") { recover(); return; }
    if (event.type === "subscription_restored") {
      invalidate(watch, null);
      request(watch);
      return;
    }
    if (event.type === "replacement") {
      invalidate(watch, event.epoch);
      request(watch);
      return;
    }
    const epoch = "epoch" in message ? message.epoch : undefined;
    if (epoch && watch.epoch !== null && epoch !== watch.epoch) {
      invalidate(watch, epoch);
      request(watch);
    } else if (epoch) watch.epoch = epoch;
    if (event.type === "timeline" && event.item.type === "user_message") {
      watch.revision++;
      remember(watch.id, event.item);
    }
  };
  const ensure = (id: string) => {
    if (stopped || !attempt) return;
    const existing = watches.get(id);
    if (existing) { watches.delete(id); watches.set(id, existing); return; }
    if (watches.size >= MAX_AGENTS) forget(watches.values().next().value!);
    const watch: Watch = { id, agent: paseo.agents.ref(id), ready: false, epoch: null, generation: 0, revision: 0, fetching: false, again: false };
    watches.set(id, watch);
    try {
      const subscription = watch.agent.timeline.subscribe((message) => receive(watch, message));
      watch.subscription = subscription;
      // Subscribe first, then read: canonical user messages arriving during the read
      // take precedence, and a stale read schedules another catch-up pass.
      void subscription.ready.then(() => {
        if (active(watch)) { watch.ready = true; request(watch); }
      }).catch(() => { if (active(watch)) recover(); });
      // A subscription can synchronously report failure before returning its handle.
      if (!active(watch)) release(subscription);
    } catch { recover(); }
  };
  async function start() {
    if (stopped) return;
    const current = new AbortController();
    attempt = current;
    try {
      const result = await paseo.agents.list({
        scope: "active", sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: MAX_AGENTS }, subscribe: {}, signal: current.signal,
      });
      if (stopped || attempt !== current) { release(result.subscription); return; }
      directory = result.subscription;
      if (!directory) throw new Error("Missing agent directory subscription");
      const stop = directory.subscribe({
        snapshot(snapshot) {
          if (stopped || attempt !== current) return;
          const ids = snapshot.entries.filter(({ agent }) => !agent.archivedAt).slice(0, MAX_AGENTS).map(({ agent }) => agent.id);
          for (const watch of watches.values()) {
            if (!ids.includes(watch.id)) forget(watch);
            else { invalidate(watch, null); request(watch); }
          }
          for (const id of [...ids].reverse()) ensure(id);
        },
        update(message) {
          if (stopped || attempt !== current || message.type !== "agent_update") return;
          if (message.payload.kind === "remove") {
            const watch = watches.get(message.payload.agentId);
            if (watch) { forget(watch); flush(); }
          } else if (message.payload.agent.archivedAt) {
            const watch = watches.get(message.payload.agent.id);
            if (watch) { forget(watch); flush(); }
          } else ensure(message.payload.agent.id);
        },
        error() { if (attempt === current) recover(); },
      });
      if (stopped || attempt !== current) stop();
      else unobserve = stop;
    } catch { if (!stopped && attempt === current) recover(); }
  }
  void start();
  return async () => {
    if (stopped) return;
    stopped = true;
    if (retry !== undefined) clearTimeout(retry);
    if (batch !== undefined) clearTimeout(batch);
    reset();
    records.clear();
    cacheChars = 0;
    await Promise.all([...releases]);
  };
}
