import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { notePresence, PRESENCE_BATCH_SIZE, readNote, saveNote, type SaveInput } from "../shared/contracts";
import { createSessionNote, type SessionNote } from "./note";
import { NotesPanel } from "./panel";

type Client = Pick<PluginClientContext, "paseo" | "addComposerPill" | "rpc">;
type Registration = ReturnType<Client["addComposerPill"]>;
type Directory = Awaited<ReturnType<Client["paseo"]["agents"]["list"]>>;
type Session = Directory["entries"][number]["agent"];
interface Pill { workspaceId: string; registration: Registration; unsubscribe(): void }

export function startNotes(client: Client) {
  const notes = new Map<string, SessionNote>();
  const pills = new Map<string, Pill>();
  const pendingPresence = new Map<string, SessionNote>();
  const releases = new Set<Promise<void>>();
  const transport = {
    read: (sessionId: string) => client.rpc(readNote, { sessionId }),
    save: (input: SaveInput) => client.rpc(saveNote, input),
  };
  let attempt: AbortController | undefined;
  let subscription: Directory["subscription"];
  let unobserve: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let presenceQueued = false;
  let stopped = false;

  function probePresence(id: string, note: SessionNote) {
    pendingPresence.set(id, note);
    if (presenceQueued) return;
    presenceQueued = true;
    void Promise.resolve().then(async () => {
      presenceQueued = false;
      const queued = [...pendingPresence];
      pendingPresence.clear();
      for (let start = 0; !stopped && start < queued.length; start += PRESENCE_BATCH_SIZE) {
        const batch = queued.slice(start, start + PRESENCE_BATCH_SIZE);
        try {
          const reply = await client.rpc(notePresence, { sessionIds: batch.map(([key]) => key) });
          if (stopped) return;
          const present = new Set(reply.present);
          for (const [key, requested] of batch) {
            if (notes.get(key) === requested) requested.setPresence(present.has(key));
          }
        } catch {
          // Presence is optional; opening the pill still reads and reports errors.
        }
      }
    });
  }

  function forget(id: string, keepNote = false) {
    const pill = pills.get(id);
    if (pill) {
      pills.delete(id);
      pill.unsubscribe();
      pill.registration.remove();
    }
    const note = notes.get(id);
    if (!keepNote && note && !note.get().hasDraft) {
      note.dispose();
      notes.delete(id);
    }
  }

  function add(agent: Session) {
    const { id, workspaceId } = agent;
    if (agent.archivedAt || !workspaceId) { forget(id); return; }
    const existing = pills.get(id);
    if (existing?.workspaceId === workspaceId) return;
    if (existing) forget(id, true);
    let source = notes.get(id);
    if (!source) {
      source = createSessionNote(id, transport);
      notes.set(id, source);
      probePresence(id, source);
    }
    const note = source;
    const Content = (props: PluginButtonContentProps) =>
      props.context === "agent" && props.agentId === id && props.workspaceId === workspaceId ? <NotesPanel {...props} note={note} /> : null;
    function presentation() {
      const state = note.get();
      if (state.status === "conflict" || (state.conflict && state.status !== "saving")) return { label: "笔记 · 有冲突", title: "会话笔记有版本冲突" };
      if (state.status === "save-error" || state.status === "too-long") return { label: "笔记 · 未保存", title: "会话笔记有未保存的草稿" };
      if (state.hasContent) return { label: "笔记 ·", title: "会话笔记（有内容）" };
      return { label: "笔记", title: "会话笔记" };
    }
    let shown = presentation();
    const registration = client.addComposerPill({ id: `conversation-notes-${id}`, agentId: id, workspaceId,
      button: { ...shown, icon: "FileText", behavior: { kind: "popover", Content } } });
    const unsubscribe = note.subscribe(() => {
      const next = presentation();
      if (shown.label !== next.label) { shown = next; registration.update(next); }
    });
    pills.set(id, { workspaceId, registration, unsubscribe });
  }

  function release(source: Directory["subscription"]) {
    if (!source) return;
    const pending = source.release().catch(() => {});
    releases.add(pending);
    void pending.then(() => { releases.delete(pending); });
  }

  function disconnect() {
    attempt?.abort();
    attempt = undefined;
    unobserve?.();
    unobserve = undefined;
    release(subscription);
    subscription = undefined;
  }

  function reconnect() {
    if (stopped || retry !== undefined) return;
    disconnect();
    retry = setTimeout(() => { retry = undefined; void connect(); }, 2000);
  }

  async function connect() {
    const controller = new AbortController();
    attempt = controller;
    const active = () => !stopped && attempt === controller;
    try {
      // Sequenced sync without a cursor supplies a full active directory, not the default 200-entry page.
      const result = await client.paseo.agents.list({ scope: "active", sync: {}, subscribe: {}, signal: controller.signal });
      if (!active()) { release(result.subscription); return; }
      subscription = result.subscription;
      const stop = subscription.subscribe({
        snapshot(value) {
          if (!active()) return;
          const next = new Set(value.entries.map(({ agent }) => agent.id));
          for (const id of pills.keys()) if (!next.has(id)) forget(id);
          for (const { agent } of value.entries) add(agent);
        },
        update(message) {
          if (!active() || message.type !== "agent_update") return;
          if (message.payload.kind === "upsert") add(message.payload.agent);
          else forget(message.payload.agentId);
        },
        error() { if (active()) reconnect(); },
      });
      if (active()) unobserve = stop;
      else stop();
    } catch { if (active()) reconnect(); }
  }

  void connect();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    disconnect();
    for (const id of pills.keys()) forget(id);
    for (const note of notes.values()) note.dispose();
    notes.clear();
    pendingPresence.clear();
    await Promise.all(releases);
  };
}
