import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { formatMarkdown, taskMarkers } from "../client/markdown";
import { createSessionNote, type SessionNote } from "../client/note";
import { MAX_NOTE_LENGTH, type Note, type SaveInput, type SaveResult } from "../shared/contracts";
import { deferred } from "./deferred";

const blank: Note = { revision: null, markdown: "" };
const saved = (markdown: string): Note => ({ revision: randomUUID(), markdown });
const text = (note: SessionNote) => note.get().markdown;
const edit = (note: SessionNote, value: string) => note.edit(value);
function until(note: SessionNote, predicate: (state: ReturnType<SessionNote["get"]>) => boolean) {
  if (predicate(note.get())) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = note.subscribe(() => { if (predicate(note.get())) { stop(); resolve(); } });
  });
}
const ready = (note: SessionNote) => until(note, (state) => state.status === "ready");
function create(t: TestContext, id: string, transport: Parameters<typeof createSessionNote>[1], delay = 60_000) {
  const note = createSessionNote(id, transport, delay);
  t.after(note.dispose);
  return note;
}

test("closing with a pending checkbox saves Markdown and a new client reopens it as checked", async (t) => {
  let stored = saved("# 决定\r\n\r\n- [ ] 查**资料**  \r\n");
  const read = async () => stored;
  const save = async (request: SaveInput): Promise<SaveResult> => {
    assert.equal(request.sessionId, "a"); assert.equal(request.expectedRevision, stored.revision);
    stored = saved(request.markdown); return { status: "saved", note: stored };
  };
  const left = create(t, "a", { read, save });
  const close = left.mount(); await ready(left);
  const original = text(left);
  left.edit(formatMarkdown(original, { start: original.indexOf("查"), end: original.indexOf("查") }, "toggle-task").markdown);
  assert.equal(left.get().status, "pending");
  close(); await ready(left);
  assert.equal(stored.markdown, "# 决定\r\n\r\n- [x] 查**资料**  \r\n");
  const right = create(t, "a", { read, save });
  right.mount(); await ready(right);
  assert.equal(text(right), stored.markdown);
  assert.deepEqual(taskMarkers(text(right)).map(({ checked }) => checked), [true]);
  assert.equal(right.get().hasContent, true);
});

test("a clean reopened note reads the newest saved revision; a stale deferred read cannot replace it", async (t) => {
  const old = deferred<Note>(); const newer = deferred<Note>();
  let reads = 0;
  const transport = {
    read: (id: string) => id === "b" ? Promise.resolve(saved("B")) : [old.promise, newer.promise, Promise.resolve(saved("重新打开"))][reads++]!,
    save: async (): Promise<SaveResult> => { throw new Error("unexpected save"); },
  };
  const a = create(t, "a", transport), b = create(t, "b", transport);
  a.mount()();
  b.mount(); await ready(b); assert.equal(text(b), "B");
  const close = a.mount(); newer.resolve(saved("A")); await ready(a);
  old.resolve(saved("迟到的 A")); await old.promise;
  assert.equal(text(a), "A"); assert.equal(text(b), "B");
  close(); a.mount(); await ready(a); assert.equal(text(a), "重新打开");
});

test("a late save and the immediate follow-up after close never write into the next conversation", async (t) => {
  const late = deferred<SaveResult>();
  const requests: SaveInput[] = [];
  const transport = {
    read: async (id: string) => id === "a" ? blank : saved("B"),
    save: async (request: SaveInput): Promise<SaveResult> => {
      requests.push(request);
      return requests.length === 1 ? late.promise : { status: "saved", note: saved(request.markdown) };
    },
  };
  const a = create(t, "a", transport), b = create(t, "b", transport);
  const close = a.mount(); await ready(a);
  edit(a, "A 第一段"); void a.flush();
  edit(a, "A 最后一段"); close();
  b.mount(); await ready(b); edit(b, "B 草稿");
  const first = saved("A 第一段"); late.resolve({ status: "saved", note: first });
  await ready(a);
  assert.deepEqual(requests, [
    { sessionId: "a", expectedRevision: null, markdown: "A 第一段" },
    { sessionId: "a", expectedRevision: first.revision, markdown: "A 最后一段" },
  ]);
  assert.equal(text(b), "B 草稿"); assert.equal(b.get().status, "pending");
});

test("failed autosave leaves a draft on close and reopen and retries with the same expected revision", { timeout: 3000 }, async (t) => {
  const previous = saved("上次保存"); let reads = 0; let failed = true;
  const requests: SaveInput[] = [];
  const note = create(t, "a", {
    read: async () => { reads++; return previous; },
    save: async (request) => {
      requests.push(request);
      if (failed) throw new Error("offline");
      return { status: "saved", note: saved(request.markdown) };
    },
  }, 0);
  const close = note.mount(); await ready(note);
  edit(note, "待保存草稿"); await until(note, ({ status }) => status === "save-error");
  close(); note.mount();
  assert.equal(reads, 1); assert.equal(text(note), "待保存草稿"); assert.equal(note.get().hasDraft, true);
  failed = false; await note.flush();
  assert.equal(note.get().status, "ready"); assert.equal(note.get().hasDraft, false);
  const expected = { sessionId: "a", expectedRevision: previous.revision, markdown: "待保存草稿" };
  assert.deepEqual(requests, [expected, expected]);
});

test("editing back to the old text preserves the draft if the save may already have reached the host", async (t) => {
  const initial = saved("旧笔记"); const committed = saved("宿主已写入");
  let writes = 0;
  const note = create(t, "a", {
    read: async () => initial,
    save: async () => {
      if (++writes === 1) throw new Error("reply lost after commit");
      return { status: "conflict", note: committed };
    },
  });
  const close = note.mount(); await ready(note);
  edit(note, committed.markdown); await note.flush();
  edit(note, initial.markdown);
  assert.equal(note.get().hasDraft, true);
  assert.equal(note.get().status, "save-error");
  close(); note.mount(); await note.flush();
  assert.equal(text(note), initial.markdown);
  assert.equal(note.get().conflict, committed);
});

test("only an explicit replace can advance the expected revision, and a newer conflict is checked again", async (t) => {
  const initial = saved("旧笔记"); let server = initial;
  const attempted: SaveInput[] = [];
  const note = create(t, "a", {
    read: async () => server,
    save: async (request) => {
      attempted.push(request);
      if (request.expectedRevision !== server.revision) return { status: "conflict", note: server };
      server = saved(request.markdown); return { status: "saved", note: server };
    },
  });
  const close = note.mount(); await ready(note);
  edit(note, "我的草稿");
  const other1 = saved("别处改过"); server = other1;
  await note.flush();
  assert.equal(text(note), "我的草稿"); assert.equal(note.get().conflict, other1);
  close(); note.mount(); await note.flush();
  assert.equal(attempted.length, 1); assert.equal(server, other1);
  const other2 = saved("别处又改过"); server = other2;
  await note.useDraft();
  assert.equal(attempted[1]?.expectedRevision, other1.revision);
  assert.equal(note.get().status, "conflict"); assert.equal(note.get().conflict, other2);
  await note.useDraft();
  assert.equal(attempted[2]?.expectedRevision, other2.revision);
  assert.equal(server.markdown, "我的草稿"); assert.equal(note.get().status, "ready");
});

test("over-limit edits stay available locally and saving resumes after shortening", async (t) => {
  let writes = 0;
  const note = create(t, "a", {
    read: async () => blank,
    save: async (request) => { writes++; return { status: "saved", note: saved(request.markdown) }; },
  });
  note.mount(); await ready(note);
  edit(note, "字".repeat(MAX_NOTE_LENGTH + 1)); await note.flush();
  assert.equal(note.get().status, "too-long"); assert.equal(writes, 0);
  assert.equal(text(note).length, MAX_NOTE_LENGTH + 1);
  edit(note, "缩短"); await note.flush();
  assert.equal(text(note), "缩短"); assert.equal(writes, 1); assert.equal(note.get().hasDraft, false);
});
