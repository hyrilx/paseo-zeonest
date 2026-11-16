import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { SessionStatsDetails } from "./details";
import { observePreferences } from "./preferences";
import { countInput, createCounter, createMeasurements, type CountInput } from "./statistics";
import { createStatsStore, speed, type StatsStore } from "./store";
import type { Agent, AgentSnapshot, Paseo, TimelineMessage } from "./types";

const MAX_AGENTS = 32;
const PAGE_SIZE = 100;
const MAX_BUFFER = 4096;
const MAX_READS = 4;
const RETRY_MS = 2000;
type Directory = Awaited<ReturnType<Paseo["agents"]["list"]>>["subscription"];
type CountRecord = { input: CountInput; seq?: number };
interface Watch {
  id: string;
  workspaceId: string;
  agent: Agent;
  source: StatsStore;
  registration: PluginButtonRegistration;
  label: string;
  title: string;
  counter: ReturnType<typeof createCounter>;
  measurements: ReturnType<typeof createMeasurements>;
  subscription?: ReturnType<Agent["timeline"]["subscribe"]>;
  retry?: ReturnType<typeof setTimeout>;
  generation: number;
  observation: number;
  ready: boolean;
  fetching: boolean;
  again: boolean;
  epoch: string | null;
  lastSeq: number;
  countSeq: number;
  buffer: CountRecord[];
  loading: boolean;
  partial: boolean;
  warning: string;
  error: boolean;
}

export function startSessionStats(client: PluginClientContext, now = () => performance.now()) {
  const watches = new Map<string, Watch>();
  const pending = new Set<Watch>();
  const releases = new Set<Promise<void>>();
  const configuration = observePreferences(client, () => { for (const watch of watches.values()) publish(watch); });
  let stopped = false;
  let reads = 0;
  let directory: Directory;
  let unobserve: (() => void) | undefined;
  let attempt: AbortController | undefined;
  let directoryRetry: ReturnType<typeof setTimeout> | undefined;
  const active = (watch: Watch) => !stopped && watches.get(watch.id) === watch;
  const release = (value: { release(): Promise<void> } | undefined) => {
    if (!value) return;
    const task = Promise.resolve().then(() => value.release()).catch(() => console.warn("[session-stats] Could not release subscription."));
    releases.add(task);
    void task.then(() => releases.delete(task));
  };
  function publish(watch: Watch) {
    if (!active(watch)) return;
    const windowSeconds = configuration.source.get().values.instantWindowSeconds;
    const metrics = watch.measurements.get(now(), windowSeconds * 1000);
    const label = watch.error ? "统计不可用" : metrics.instantTps === null ? "会话统计" : speed(metrics.instantTps);
    const title = watch.error ? "会话统计 · 读取失败" : `会话统计 · 输出即时速度（近 ${windowSeconds} 秒估算）`;
    watch.source.set({ ...watch.counter.get(), ...metrics, status: watch.error ? "error" : watch.loading ? "loading" : "ready", partial: watch.partial, warning: watch.warning });
    if (watch.label !== label || watch.title !== title) {
      watch.label = label; watch.title = title;
      watch.registration.update({ label, title });
    }
  }
  function invalidate(watch: Watch, epoch: string | null = null) {
    watch.generation++;
    watch.counter = createCounter();
    watch.measurements = createMeasurements();
    watch.epoch = epoch;
    watch.lastSeq = -1;
    watch.countSeq = -1;
    watch.buffer = [];
    watch.loading = true;
    watch.error = false;
    watch.partial = false;
    watch.warning = "";
    publish(watch);
  }
  function forget(watch: Watch) {
    watches.delete(watch.id);
    pending.delete(watch);
    clearTimeout(watch.retry);
    release(watch.subscription);
    watch.subscription = undefined;
    watch.registration.remove();
    watch.source.set({ ...watch.source.get(), status: "error", instantTps: null, warning: "会话已移除，请关闭此弹窗。" });
  }
  function fail(watch: Watch) {
    if (!active(watch)) return;
    watch.generation++;
    watch.observation++;
    watch.ready = false;
    watch.error = true;
    watch.partial = true;
    watch.warning = "连接或历史读取失败，计数可能不完整。恢复连接后将重新回填并开始观测。";
    watch.measurements = createMeasurements();
    release(watch.subscription);
    watch.subscription = undefined;
    pending.delete(watch);
    publish(watch);
    clearTimeout(watch.retry);
    watch.retry = setTimeout(() => attach(watch), RETRY_MS);
  }
  function request(watch: Watch) {
    if (!active(watch) || !watch.ready) return;
    if (watch.fetching) { watch.again = true; return; }
    pending.add(watch);
    pump();
  }
  async function fetchHistory(watch: Watch) {
    const generation = watch.generation;
    let cursor: Awaited<ReturnType<Agent["timeline"]["refetch"]>>["startCursor"] = null;
    const pages: CountRecord[][] = [];
    let highSeq = -1;
    let partial = false;
    while (true) {
      const response = await watch.agent.timeline.refetch({ direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: PAGE_SIZE, projection: "canonical" });
      if (!active(watch) || generation !== watch.generation) return;
      if (response.error || response.agentId !== watch.id) throw new Error("Invalid session statistics history response");
      if (watch.epoch !== null && response.epoch !== watch.epoch) {
        invalidate(watch, response.epoch);
        watch.again = true;
        return;
      }
      watch.epoch = response.epoch;
      if (response.staleCursor || response.gap) throw new Error("Session statistics history has a gap");
      pages.push(response.entries.flatMap((entry) => {
        highSeq = Math.max(highSeq, entry.seqEnd);
        const input = countInput(entry.item, entry.turnId);
        return input ? [{ input, seq: entry.seqEnd }] : [];
      }));
      partial = response.hasOlder;
      if (!response.hasOlder) break;
      if (!response.startCursor || response.startCursor.epoch !== response.epoch || (cursor && response.startCursor.seq >= cursor.seq)) break;
      cursor = response.startCursor;
    }
    if (!active(watch) || generation !== watch.generation) return;
    const counter = createCounter();
    for (const page of pages.reverse()) for (const record of page) counter.add(record.input);
    watch.countSeq = highSeq;
    for (const record of watch.buffer) {
      if (record.seq === undefined) { partial = true; continue; }
      if (record.seq <= watch.countSeq) continue;
      counter.add(record.input);
      watch.countSeq = record.seq;
    }
    watch.counter = counter;
    watch.buffer = [];
    watch.partial ||= partial;
    if (watch.partial) watch.warning = "部分历史或实时事件未能完整合并，显示的是已加载计数。";
    watch.loading = false;
    publish(watch);
  }
  function pump() {
    if (stopped) return;
    while (reads < MAX_READS && pending.size) {
      const watch = pending.values().next().value!;
      pending.delete(watch);
      if (!active(watch) || !watch.ready) continue;
      watch.fetching = true;
      watch.again = false;
      reads++;
      const generation = watch.generation;
      void fetchHistory(watch).catch(() => { if (active(watch) && watch.generation === generation) fail(watch); }).finally(() => {
        reads--;
        watch.fetching = false;
        if (watch.again) request(watch);
        pump();
      });
    }
  }
  function receive(watch: Watch, message: TimelineMessage) {
    if (!active(watch) || message.agentId !== watch.id || watch.error) return;
    const { event } = message;
    if (event.type === "error") { fail(watch); return; }
    if (event.type === "replacement" || event.type === "subscription_restored") {
      invalidate(watch, event.type === "replacement" ? event.epoch : null);
      request(watch);
      return;
    }
    const epoch = "epoch" in message ? message.epoch : undefined;
    if (epoch && watch.epoch !== null && epoch !== watch.epoch) { invalidate(watch, epoch); request(watch); }
    else if (epoch) watch.epoch = epoch;
    // Native timeline sequence numbers deduplicate replayed chunks and tool lifecycles.
    if (event.type === "timeline" && "seq" in message && message.seq !== undefined) {
      if (message.seq <= watch.lastSeq) return;
      watch.lastSeq = message.seq;
    }
    watch.measurements.add(event, now());
    if (event.type === "timeline") {
      const input = countInput(event.item, event.turnId);
      if (input) {
        const seq = "seq" in message ? message.seq : undefined;
        if (watch.loading) {
          watch.buffer.push({ input, seq });
          if (watch.buffer.length > MAX_BUFFER) { watch.buffer.shift(); watch.partial = true; }
        } else if (seq === undefined || seq > watch.countSeq) {
          watch.counter.add(input);
          if (seq !== undefined) watch.countSeq = seq;
          else { watch.partial = true; watch.warning = "部分实时事件缺少序号，无法保证计数完整去重。"; }
        }
      }
    }
  }
  function attach(watch: Watch) {
    if (!active(watch)) return;
    clearTimeout(watch.retry);
    release(watch.subscription);
    watch.subscription = undefined;
    watch.ready = false;
    invalidate(watch);
    const observation = ++watch.observation;
    try {
      const subscription = watch.agent.timeline.subscribe((message) => { if (watch.observation === observation) receive(watch, message); });
      if (!active(watch) || watch.observation !== observation) { release(subscription); return; }
      watch.subscription = subscription;
      void subscription.ready.then(() => {
        if (active(watch) && watch.observation === observation) { watch.ready = true; request(watch); }
      }).catch(() => { if (active(watch) && watch.observation === observation) fail(watch); });
    } catch { fail(watch); }
  }
  function ensure(agent: AgentSnapshot) {
    if (stopped) return;
    const existing = watches.get(agent.id);
    if (agent.archivedAt || !agent.workspaceId) { if (existing) forget(existing); return; }
    if (existing?.workspaceId === agent.workspaceId) { watches.delete(agent.id); watches.set(agent.id, existing); return; }
    if (existing) forget(existing);
    if (watches.size >= MAX_AGENTS) forget(watches.values().next().value!);
    const source = createStatsStore();
    const id = agent.id;
    const Content = (props: PluginButtonContentProps) => <SessionStatsDetails {...props} source={source} configuration={configuration.source} reloadPreferences={() => { void configuration.refresh(); }} retry={() => { const watch = watches.get(id); if (watch) attach(watch); }} />;
    const title = `会话统计 · 输出即时速度（近 ${configuration.source.get().values.instantWindowSeconds} 秒估算）`;
    const registration = client.addComposerPill({ id: `session-stats-${id}`, workspaceId: agent.workspaceId, agentId: id,
      button: { title, label: "会话统计", icon: "Gauge", behavior: { kind: "popover", Content } } });
    const watch: Watch = { id, workspaceId: agent.workspaceId, agent: client.paseo.agents.ref(agent), source, registration, label: "会话统计", title,
      counter: createCounter(), measurements: createMeasurements(), generation: 0, observation: 0, ready: false, fetching: false, again: false,
      epoch: null, lastSeq: -1, countSeq: -1, buffer: [], loading: true, partial: false, warning: "", error: false };
    watches.set(id, watch);
    attach(watch);
  }
  function disconnectDirectory() {
    attempt?.abort();
    attempt = undefined;
    unobserve?.();
    unobserve = undefined;
    release(directory);
    directory = undefined;
  }
  function recoverDirectory() {
    if (stopped || directoryRetry !== undefined) return;
    disconnectDirectory();
    for (const watch of watches.values()) { fail(watch); clearTimeout(watch.retry); }
    console.warn("[session-stats] Agent directory unavailable; retrying.");
    directoryRetry = setTimeout(() => { directoryRetry = undefined; void connectDirectory(); }, RETRY_MS);
  }
  async function connectDirectory() {
    if (stopped) return;
    const current = new AbortController();
    attempt = current;
    try {
      const result = await client.paseo.agents.list({ scope: "active", sort: [{ key: "updated_at", direction: "desc" }], page: { limit: MAX_AGENTS }, subscribe: {}, signal: current.signal });
      if (stopped || attempt !== current) { release(result.subscription); return; }
      directory = result.subscription;
      if (!directory) throw new Error("Missing session statistics directory subscription");
      const stop = directory.subscribe({
        snapshot(snapshot) {
          if (stopped || attempt !== current) return;
          const agents = snapshot.entries.map(({ agent }) => agent).filter((agent) => !agent.archivedAt && agent.workspaceId).slice(0, MAX_AGENTS);
          for (const watch of watches.values()) {
            if (!agents.some((agent) => agent.id === watch.id && agent.workspaceId === watch.workspaceId)) forget(watch);
            else attach(watch); // A replayed directory snapshot may follow a connection gap.
          }
          for (const agent of agents) ensure(agent);
        },
        update(message) {
          if (stopped || attempt !== current || message.type !== "agent_update") return;
          if (message.payload.kind === "upsert") ensure(message.payload.agent);
          else { const watch = watches.get(message.payload.agentId); if (watch) forget(watch); }
        },
        error() { if (attempt === current) recoverDirectory(); },
      });
      if (stopped || attempt !== current) stop();
      else unobserve = stop;
    } catch { if (!stopped && attempt === current) recoverDirectory(); }
  }
  // Timeline metrics use one local ticker. Only native display preferences are polled.
  const ticker = setInterval(() => { for (const watch of watches.values()) publish(watch); }, 250);
  void connectDirectory();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    configuration.stop();
    clearTimeout(directoryRetry);
    disconnectDirectory();
    for (const watch of watches.values()) forget(watch);
    pending.clear();
    await Promise.all([...releases]);
  };
}
