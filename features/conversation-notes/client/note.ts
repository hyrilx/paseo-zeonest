import { MAX_NOTE_LENGTH, type Note, type NoteUpdate, type SaveInput, type SaveResult } from "../shared/contracts";

interface NoteTransport {
  read(): Promise<Note>;
  save(input: NoteUpdate): Promise<SaveResult>;
}
type Status = "loading" | "load-error" | "ready" | "pending" | "saving" | "save-error" | "too-long" | "conflict";
interface Snapshot {
  status: Status;
  markdown: string;
  hasContent: boolean;
  hasDraft: boolean;
  conflict: Note | null;
}

export function createSessionNote(sessionId: string, transport: {
  read(sessionId: string): Promise<Note>;
  save(input: SaveInput): Promise<SaveResult>;
}, delay?: number) {
  return createNote({ read: () => transport.read(sessionId), save: (input) => transport.save({ ...input, sessionId }) }, delay);
}

export function createNote(transport: NoteTransport, delay = 600) {
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = { status: "loading", markdown: "", hasContent: false, hasDraft: false, conflict: null };
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
    publish({ status: "ready", markdown: note.markdown,
      hasContent: !!note.markdown.trim(), hasDraft: false, conflict: null });
  }
  async function load() {
    if (disposed || !mounts || snapshot.hasDraft || saving) return;
    const generation = ++loadGeneration;
    publish({ status: "loading" });
    try {
      const note = await transport.read();
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
  function edit(markdown: string) {
    if (disposed || !base || snapshot.status === "loading" || snapshot.status === "load-error" || markdown === snapshot.markdown) return;
    const hasDraft = !!snapshot.conflict || !!saving || saveUnconfirmed || markdown !== base.markdown;
    stopTimer();
    if (!hasDraft) {
      publish({ markdown, hasDraft, status: "ready", conflict: null });
      return;
    }
    let status: Status;
    if (snapshot.conflict) status = "conflict";
    else if (markdown.length > MAX_NOTE_LENGTH) status = "too-long";
    else if (saving) status = "saving";
    else if (snapshot.status === "save-error") status = "save-error";
    else { status = "pending"; schedule(); }
    publish({ markdown, hasDraft, status });
  }
  async function flush(expected?: Note) {
    stopTimer();
    if (disposed || !base || !snapshot.hasDraft || (snapshot.conflict && !expected)) return;
    if (saving) return saving;
    const { markdown } = snapshot;
    if (markdown.length > MAX_NOTE_LENGTH) {
      publish({ status: "too-long" });
      return;
    }
    const expectedRevision = (expected ?? base).revision;
    const job = Promise.resolve().then(async () => {
      let result: SaveResult;
      try { result = await transport.save({ expectedRevision, markdown }); }
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
      const current = snapshot.markdown;
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
    isOpen: () => mounts > 0,
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
    edit,
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
