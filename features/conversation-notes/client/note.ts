import { MAX_NOTE_LENGTH, type Note, type SaveInput, type SaveResult } from "../shared/contracts";
import { editBlock, emptyBlock, parseMarkdown, toMarkdown, type Block, type BlockContent } from "./blocks";

interface Transport {
  read(sessionId: string): Promise<Note>;
  save(input: SaveInput): Promise<SaveResult>;
}
type Status = "loading" | "load-error" | "ready" | "pending" | "saving" | "save-error" | "too-long" | "conflict";
interface Snapshot {
  status: Status;
  blocks: readonly Block[];
  hasContent: boolean;
  hasDraft: boolean;
  conflict: Note | null;
}
export type Cursor = { id: number; offset: number };

export function createSessionNote(sessionId: string, transport: Transport, delay = 600) {
  const listeners = new Set<() => void>();
  let nextId = 0;
  const newBlock = (content: BlockContent): Block => ({ ...content, id: ++nextId });
  let snapshot: Snapshot = { status: "loading", blocks: [newBlock(emptyBlock())], hasContent: false, hasDraft: false, conflict: null };
  let base: Note | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | undefined;
  let saveUnconfirmed = false;
  let loadGeneration = 0;
  let loaded = false;
  let mounts = 0;
  let disposed = false;

  function publish(patch: Partial<Snapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function receive(note: Note) {
    base = note;
    loaded = true;
    saveUnconfirmed = false;
    publish({ status: "ready", blocks: parseMarkdown(note.markdown).map(newBlock),
      hasContent: !!note.markdown.trim(), hasDraft: false, conflict: null });
  }
  async function load() {
    if (disposed || !mounts || snapshot.hasDraft || saving) return;
    const generation = ++loadGeneration;
    publish({ status: "loading" });
    try {
      const note = await transport.read(sessionId);
      if (!disposed && mounts && generation === loadGeneration) receive(note);
    } catch {
      if (!disposed && mounts && generation === loadGeneration) publish({ status: "load-error" });
    }
  }
  function stopTimer() {
    clearTimeout(timer);
    timer = undefined;
  }
  function schedule() {
    stopTimer();
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  }
  function change(blocks: readonly Block[]) {
    if (disposed || !base || snapshot.status === "loading" || snapshot.status === "load-error") return;
    const markdown = toMarkdown(blocks);
    const hasDraft = !!snapshot.conflict || !!saving || saveUnconfirmed || markdown !== base.markdown;
    stopTimer();
    if (!hasDraft) {
      publish({ blocks, hasDraft, status: "ready", conflict: null });
      return;
    }
    let status: Status;
    if (snapshot.conflict) status = "conflict";
    else if (markdown.length > MAX_NOTE_LENGTH) status = "too-long";
    else if (saving) status = "saving";
    else if (snapshot.status === "save-error") status = "save-error";
    else { status = "pending"; schedule(); }
    publish({ blocks, hasDraft, status });
  }
  async function flush(expected?: Note) {
    stopTimer();
    if (disposed || !base || !snapshot.hasDraft || (snapshot.conflict && !expected)) return;
    if (saving) return saving;
    const markdown = toMarkdown(snapshot.blocks);
    if (markdown.length > MAX_NOTE_LENGTH) {
      publish({ status: "too-long" });
      return;
    }
    const expectedRevision = (expected ?? base).revision;
    const job = Promise.resolve().then(async () => {
      let result: SaveResult;
      try { result = await transport.save({ sessionId, expectedRevision, markdown }); }
      catch {
        saving = undefined;
        // The host may have committed before the connection failed.
        saveUnconfirmed = true;
        if (!disposed) publish({ status: "save-error" });
        return;
      }
      saving = undefined;
      saveUnconfirmed = false;
      if (disposed) return;
      if (result.status === "conflict") {
        publish({ status: "conflict", conflict: result.note });
        return;
      }
      base = result.note;
      loaded = true;
      const current = toMarkdown(snapshot.blocks);
      const hasDraft = current !== base.markdown;
      const status = !hasDraft ? "ready" : current.length > MAX_NOTE_LENGTH ? "too-long" : "pending";
      publish({ status, hasContent: !!base.markdown.trim(), hasDraft, conflict: null });
      if (!saving && snapshot.status === "pending") {
        if (mounts) schedule();
        else void flush();
      }
    });
    saving = job;
    publish({ status: "saving" });
    return job;
  }
  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setPresence(hasContent: boolean) {
      if (!disposed && !loaded && snapshot.hasContent !== hasContent) publish({ hasContent });
    },
    mount() {
      if (disposed) return () => {};
      if (++mounts === 1) void load();
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        if (--mounts !== 0) return;
        ++loadGeneration;
        if (snapshot.status === "pending" || snapshot.status === "saving") void flush();
      };
    },
    async loadAgain() { await load(); },
    edit(id: number, text: string): Cursor | null {
      const index = snapshot.blocks.findIndex((block) => block.id === id);
      if (index < 0) return null;
      const edited = editBlock(snapshot.blocks[index]!, text);
      const blocks = edited.blocks.map((content, i): Block => i === 0 ? { ...content, id } : newBlock(content));
      change([...snapshot.blocks.slice(0, index), ...blocks, ...snapshot.blocks.slice(index + 1)]);
      return edited.focus && { id: blocks[edited.focus.index]!.id, offset: edited.focus.offset };
    },
    toggle(id: number) {
      change(snapshot.blocks.map((block) => block.id === id && block.kind === "task" ? { ...block, checked: !block.checked } : block));
    },
    append() {
      const block = newBlock(emptyBlock());
      change([...snapshot.blocks, block]);
      return { id: block.id, offset: 0 };
    },
    remove(id: number) {
      const remaining = snapshot.blocks.filter((block) => block.id !== id);
      change(remaining.length ? remaining : [newBlock(emptyBlock())]);
    },
    flush: () => flush(),
    keepServer() {
      if (snapshot.status !== "saving" && snapshot.conflict) {
        receive(snapshot.conflict);
        void load();
      }
    },
    useDraft() {
      if (snapshot.conflict) return flush(snapshot.conflict);
    },
    dispose() {
      disposed = true;
      stopTimer();
      listeners.clear();
    },
  };
}
export type SessionNote = ReturnType<typeof createSessionNote>;
