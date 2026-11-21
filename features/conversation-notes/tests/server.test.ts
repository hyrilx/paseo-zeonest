import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../server/index";
import contributeRpc from "../server/rpc";
import contributeSettings from "../server/settings";
import { NoteStore } from "../server/store";
import { MAX_SNIPPET_LENGTH, notePresence, noteSummaries, readGlobalNote, readNote, saveGlobalNote, saveNote, type SaveInput } from "../shared/contracts";
import { preferences } from "../shared/settings";

const blank = { revision: null, markdown: "" };
const guard = () => {};
const input = (sessionId: string, markdown: string, expectedRevision: SaveInput["expectedRevision"] = null) => ({ sessionId, markdown, expectedRevision });
async function home(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "zeonest-conversation-notes-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("one Markdown note per conversation, including two sessions in the same workspace", async (t) => {
  const directory = join(await home(t), "notes");
  const writer = new NoteStore(directory);
  const markdown = "# 决定\n- [x] 检查链接\n- [ ] 再确认\n- https://example.com";
  assert.deepEqual(await writer.read("w/one", guard), blank);
  const first = await writer.save(input("w/one", markdown), guard);
  assert.equal(first.status, "saved");
  assert.ok(first.note.revision);
  assert.deepEqual(await writer.read("w/two", guard), blank);
  const second = await writer.save(input("w/two", "另一段笔记"), guard);
  const reopened = new NoteStore(directory);
  assert.deepEqual(await reopened.read("w/one", guard), { revision: first.note.revision, markdown });
  assert.deepEqual(await reopened.read("w/two", guard), second.note);
  assert.deepEqual(await reopened.presence(["w/one", "w/none", "w/two"], guard), ["w/one", "w/two"]);
  assert.ok((await readdir(directory)).every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
});

test("compare and save serializes clients, and clearing a note does not revive an old revision", async (t) => {
  const directory = join(await home(t), "notes");
  const left = new NoteStore(directory), right = new NoteStore(directory);
  const first = await left.save(input("a", "共同版本"), guard);
  const revision = first.note.revision;
  const [one, two] = await Promise.all([
    left.save(input("a", "客户端一", revision), guard),
    right.save(input("a", "客户端二", revision), guard),
  ]);
  assert.equal(one.status, "saved");
  assert.deepEqual(two, { status: "conflict", note: one.note });
  assert.deepEqual(await right.read("a", guard), one.note);
  assert.deepEqual(await left.save(input("a", "客户端一", revision), guard), one, "retrying an already committed body is idempotent");
  const cleared = await left.save(input("a", "", one.note.revision), guard);
  assert.equal(cleared.status, "saved");
  assert.ok(cleared.note.revision);
  assert.notEqual(cleared.note.revision, one.note.revision);
  assert.deepEqual(await left.presence(["a"], guard), []);
  assert.deepEqual(await right.save(input("a", "更早的草稿"), guard), { status: "conflict", note: cleared.note });
});

test("failed writes leave the previous revision readable and a stopped queued write cannot commit", async (t) => {
  const directory = join(await home(t), "notes");
  await mkdir(directory);
  const store = new NoteStore(directory);
  const first = await store.save(input("a", "已保存"), guard);
  // Reject immediately before rename, after the temporary file was written.
  let calls = 0;
  const stopAtCommit = () => { if (++calls >= 6) throw new Error("stopped"); };
  await assert.rejects(store.save(input("a", "短暂草稿", first.note.revision), stopAtCommit), /stopped/);
  assert.deepEqual(await store.read("a", guard), first.note);
  assert.equal((await readdir(directory)).length, 1);
  const path = join(directory, (await readdir(directory))[0]!);
  await writeFile(path, "{broken JSON");
  await assert.rejects(store.save(input("a", "不覆盖损坏记录", first.note.revision), guard));
  await assert.rejects(store.read("a", guard));
});

test("global note uses its own record and revision; the catalog summarizes existing session files", async (t) => {
  const directory = join(await home(t), "notes");
  const store = new NoteStore(directory);
  const sessionNote = await store.save(input("global", "# 会话标题\n- [x] " + "字".repeat(211)), guard);
  assert.deepEqual(await store.readGlobal(guard), blank);
  const global = await store.saveGlobal({ expectedRevision: null, markdown: "# 仅宿主全局内容" }, guard);
  assert.equal(global.status, "saved");
  assert.deepEqual(await new NoteStore(directory).readGlobal(guard), global.note);
  assert.notEqual(sessionNote.note.revision, global.note.revision);
  assert.deepEqual(await store.saveGlobal({ expectedRevision: null, markdown: "旧草稿" }, guard), { status: "conflict", note: global.note });
  await store.save(input("broken", "一度可读"), guard);
  await writeFile(join(directory, createHash("sha256").update("broken").digest("hex") + ".json"), "{broken JSON");
  const result = await store.summaries(["broken", "global", "global", "missing"], guard);
  assert.deepEqual(result.unreadable, ["broken"]);
  assert.equal(result.notes.length, 1);
  const summary = result.notes.find((item) => item.sessionId === "global");
  assert.ok(summary && summary.updatedAt > 0);
  assert.doesNotMatch(summary.snippet, /仅宿主全局内容|\[x\]/);
  assert.equal(summary.snippet.length, MAX_SNIPPET_LENGTH);
  await store.save(input("global", "", sessionNote.note.revision), guard);
  assert.deepEqual(await store.summaries(["global"], guard), { notes: [], unreadable: [] });
  assert.deepEqual(await store.readGlobal(guard), global.note);
});

test("host preferences register independently of note activation and have safe defaults", () => {
  const registered: (typeof preferences)[] = [];
  const cleanup = contributeSettings({ registerSettings: (value: typeof preferences) => registered.push(value) } as unknown as PluginServerContext);
  assert.deepEqual(registered, [preferences]);
  assert.equal(preferences.scope, "host");
  assert.equal(preferences.version, 1);
  assert.deepEqual(preferences.schema.parse({}), { defaultView: "edit", editorSize: "standard", showToolbar: true });
  assert.equal(preferences.schema.safeParse({ defaultView: "remember" }).success, false);
  cleanup();
});

test("all RPCs register synchronously and deny calls while inactive or after cleanup", async (t) => {
  const directory = await home(t);
  const old = process.env.PASEO_HOME;
  process.env.PASEO_HOME = directory;
  t.after(() => { if (old === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = old; });
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const server = { handle: (contract: { name: string }, handler: (value: unknown) => Promise<unknown>) => handlers.set(contract.name, handler) } as unknown as PluginServerContext;
  const stopRpc = contributeRpc(server);
  t.after(stopRpc);
  assert.deepEqual([...handlers.keys()], [readNote.name, saveNote.name, notePresence.name, readGlobalNote.name, saveGlobalNote.name, noteSummaries.name]);
  const read = () => handlers.get(readNote.name)!({ sessionId: "a" });
  const save = () => handlers.get(saveNote.name)!(input("a", "内容"));
  const presence = () => handlers.get(notePresence.name)!({ sessionIds: ["a"] });
  const globalRead = () => handlers.get(readGlobalNote.name)!({});
  const globalSave = () => handlers.get(saveGlobalNote.name)!({ expectedRevision: null, markdown: "全局正文" });
  const summaries = () => handlers.get(noteSummaries.name)!({ sessionIds: ["a"] });
  const calls = [read, save, presence, globalRead, globalSave, summaries];
  for (const call of calls) await assert.rejects(call, /未启用或已停止/);
  const stop = contribute(server);
  t.after(stop);
  assert.deepEqual(await read(), blank);
  const pending = save();
  stop();
  await assert.rejects(pending, /未启用或已停止/);
  for (const call of calls) await assert.rejects(call, /未启用或已停止/);
  const restart = contribute(server);
  t.after(restart);
  assert.deepEqual(await read(), blank);
  assert.deepEqual(await handlers.get(saveNote.name)!(input("a", "草稿", randomUUID())), { status: "conflict", note: blank });
  assert.deepEqual(await globalRead(), blank);
  assert.equal((await globalSave() as { status: string }).status, "saved");
  assert.deepEqual(await summaries(), { notes: [], unreadable: [] });
  stopRpc();
  for (const call of calls) await assert.rejects(call, /已停止/);
});
