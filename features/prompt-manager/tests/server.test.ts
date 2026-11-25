import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test, { type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeServer from "../server/index";
import contributeRpc from "../server/rpc";
import { PromptStore } from "../server/store";
import { deletePrompt, listPrompts, savePrompt, type SavePromptInput } from "../shared/contracts";
import { createSamplePromptDraft } from "../shared/template";

const guard = () => {};

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zeonest-prompt-manager-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeInput(overrides: Partial<SavePromptInput> = {}): SavePromptInput {
  return {
    name: "测试模板",
    description: "说明",
    tags: ["效率", "效率", "代码"],
    template: "你好 {{name}}",
    placeholders: [
      { key: "name", label: "称呼", description: "", type: "text", placeholder: "", defaultValue: "世界", multiline: false },
    ],
    expectedRevision: null,
    ...overrides,
  };
}

test("PromptStore supports CRUD, tag dedupe, sorting, and persistence across instances", async (t) => {
  const dir = join(await tempDir(t), "prompts");
  const store = new PromptStore(dir);

  assert.deepEqual(await store.list(guard), []);

  const created = await store.save(makeInput(), guard);
  assert.equal(created.status, "saved");
  assert.deepEqual(created.prompt.tags, ["效率", "代码"]);

  const sample = await store.save({ ...createSamplePromptDraft(), expectedRevision: null }, guard);
  assert.equal(sample.status, "saved");

  const reopened = new PromptStore(dir);
  const listed = await reopened.list(guard);
  assert.equal(listed.length, 2);

  const updated = await reopened.save(
    makeInput({ id: created.prompt.id, name: "已更新模板", expectedRevision: created.prompt.revision }),
    guard,
  );
  assert.equal(updated.status, "saved");
  assert.equal(updated.prompt.name, "已更新模板");
  assert.notEqual(updated.prompt.revision, created.prompt.revision);

  const removed = await reopened.remove({ id: created.prompt.id, expectedRevision: updated.prompt.revision }, guard);
  assert.deepEqual(removed, { status: "deleted", id: created.prompt.id });

  const missing = await reopened.remove({ id: created.prompt.id }, guard);
  assert.deepEqual(missing, { status: "not-found", id: created.prompt.id });
});

test("PromptStore serializes concurrent saves and detects revision conflicts", async (t) => {
  const dir = join(await tempDir(t), "prompts");
  const left = new PromptStore(dir);
  const right = new PromptStore(dir);

  const first = await left.save(makeInput({ name: "初版" }), guard);
  assert.equal(first.status, "saved");

  const [one, two] = await Promise.all([
    left.save(makeInput({ id: first.prompt.id, name: "客户端一", expectedRevision: first.prompt.revision }), guard),
    right.save(makeInput({ id: first.prompt.id, name: "客户端二", expectedRevision: first.prompt.revision }), guard),
  ]);

  assert.equal(one.status, "saved");
  assert.equal(two.status, "conflict");
  assert.deepEqual(two.current, one.prompt);

  // Stale delete also reports conflict
  const staleDelete = await right.remove({ id: first.prompt.id, expectedRevision: first.prompt.revision }, guard);
  assert.equal(staleDelete.status, "conflict");
  assert.deepEqual(staleDelete.current, one.prompt);
});

test("PromptStore aborts safely on guard failure and refuses to overwrite corrupt files", async (t) => {
  const dir = join(await tempDir(t), "prompts");
  const store = new PromptStore(dir);

  const saved = await store.save(makeInput({ name: "安全版本" }), guard);
  assert.equal(saved.status, "saved");

  let checks = 0;
  const failBeforeRename = () => {
    if (++checks >= 6) throw new Error("stopped");
  };
  await assert.rejects(
    store.save(makeInput({ id: saved.prompt.id, name: "半途停止", expectedRevision: saved.prompt.revision }), failBeforeRename),
    /stopped/,
  );

  // Previous file intact and temporary file cleaned up
  assert.deepEqual((await store.list(guard)).map((p) => p.name), ["安全版本"]);
  assert.deepEqual(await readdir(dir), ["prompts.json"]);

  // Corrupt store file is rejected rather than overwritten
  await writeFile(store.filePath, "{broken", "utf8");
  await assert.rejects(store.list(guard));
  await assert.rejects(store.save(makeInput(), guard));
});

test("server RPC declares synchronously, rejects when disabled or stopped, and works when enabled", async (t) => {
  const fakeHome = await tempDir(t);
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = fakeHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });

  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const server = {
    handle(contract: { name: string }, handler: (input: unknown) => Promise<unknown>) {
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext;

  const stopRpc = contributeRpc(server);
  t.after(() => { void stopRpc(); });

  assert.deepEqual([...handlers.keys()].sort(), [deletePrompt.name, listPrompts.name, savePrompt.name].sort());

  // Feature disabled -> RPC rejects
  await assert.rejects(() => handlers.get(listPrompts.name)!({}), /未启用|已停止/);
  await assert.rejects(() => handlers.get(savePrompt.name)!(makeInput()), /未启用|已停止/);

  // Enable server feature -> CRUD works
  const stopServer = contributeServer(server);
  const initial = (await handlers.get(listPrompts.name)!({})) as { prompts: unknown[] };
  assert.deepEqual(initial.prompts, []);

  const saved = (await handlers.get(savePrompt.name)!(makeInput({ name: "RPC 模板" }))) as {
    status: "saved";
    prompt: { id: string; revision: string; name: string };
  };
  assert.equal(saved.status, "saved");
  assert.equal(saved.prompt.name, "RPC 模板");

  const deleted = (await handlers.get(deletePrompt.name)!({
    id: saved.prompt.id,
    expectedRevision: saved.prompt.revision,
  })) as { status: string };
  assert.equal(deleted.status, "deleted");

  // Disable server feature -> RPC rejects again
  await stopServer();
  await assert.rejects(() => handlers.get(listPrompts.name)!({}), /未启用|已停止/);

  // Re-enable then stop RPC -> RPC stays rejected
  const stopServerAgain = contributeServer(server);
  t.after(() => { void stopServerAgain(); });
  await stopRpc();
  await assert.rejects(() => handlers.get(listPrompts.name)!({}), /已停止/);
});
