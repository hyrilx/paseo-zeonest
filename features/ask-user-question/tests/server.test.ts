import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../server/index";
import register from "../server/rpc";
import { MAX_SESSION_BYTES, parseSession, readSession, recover } from "../server/session";
import { nativeSummary, type Questionnaire } from "../shared/questionnaire";
import { questions, result } from "./fixtures/questionnaire";

const sessionId = "synthetic-session";
const callId = "call-exact|suffix";
const data = { questions, result };
const request = { agentId: "agent-test", callId, summary: nativeSummary(data) };
const header = { type: "session", version: 3, id: sessionId };
const call = (id = "call-node", parentId: string | null = null, value = data) => ({
  type: "message", id, parentId,
  message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "ask_user_question", arguments: { questions: value.questions } }] },
});
const answer = (id = "answer-node", parentId = "call-node", value = data) => ({
  type: "message", id, parentId,
  message: { role: "toolResult", toolCallId: callId, toolName: "ask_user_question", details: value.result, isError: false },
});
const jsonl = (...entries: unknown[]) => [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const session = jsonl(call(), answer());

function api(persistence = { provider: "pi", sessionId, nativeHandle: "/host/session.jsonl" }) {
  let current = { persistence };
  const handle = { refresh: async () => ({ agent: current }), current: () => current };
  return {
    paseo: { agents: { ref: (id: string) => { assert.equal(id, request.agentId); return handle; } } } as unknown as Pick<PaseoApi, "agents">,
    change: (value: typeof persistence) => { current = { persistence: value }; },
  };
}

test("native Pi call/result recovers all options and notes by exact call ID", () => {
  assert.deepEqual(parseSession(session, sessionId, callId, request.summary), data);
  assert.equal(parseSession(session, sessionId, "call-exact", request.summary), null);
  assert.equal(parseSession(session, "other-session", callId, request.summary), null);
  assert.equal(parseSession(session, sessionId, callId, "different summary"), null);
  for (const extra of [{ cancelled: true }, { error: "no_ui" }, { answers: [result.answers[0]!], unanswered: [1, 2] }]) {
    const value = { questions, result: { ...result, ...extra } };
    assert.deepEqual(parseSession(jsonl(call("call-node", null, value), answer("answer-node", "call-node", value)),
      sessionId, callId, nativeSummary(value)), value);
  }
});

test("recovery follows the active parent branch and rejects duplicate or broken mappings", () => {
  const unrelated = { type: "message", id: "other-branch", parentId: null, message: { role: "user", content: "new branch" } };
  assert.equal(parseSession(jsonl(call(), answer(), unrelated), sessionId, callId, request.summary), null);
  const other = { questions, result: { ...result, answers: [] } };
  const fork = jsonl(call(), answer(), call("fork-call", null, other), answer("fork-result", "fork-call", other));
  assert.deepEqual(parseSession(fork, sessionId, callId, nativeSummary(other)), other);
  for (const text of [
    jsonl(call(), answer(), call("duplicate", "answer-node"), answer("duplicate-result", "duplicate")),
    jsonl(call(), answer("answer-node", "missing")),
    jsonl(call(), answer("call-node")),
    jsonl({ ...call(), parentId: "answer-node" }, answer()),
    jsonl(answer()), jsonl(call()),
    jsonl(call(), { ...answer(), message: { ...answer().message, isError: true } }),
    session.replace('"questionIndex":0', '"questionIndex":100'),
    session + "{invalid}\n",
  ]) assert.equal(parseSession(text, sessionId, callId, request.summary), null);
  assert.deepEqual(parseSession(session + '{"type":"message"', sessionId, callId, request.summary), data);
});

test("only the requested host-provided Pi session path is read, with stale-session checks", async () => {
  const host = api();
  let reads = 0;
  const read = async (path: string) => { reads++; assert.equal(path, "/host/session.jsonl"); return session; };
  assert.deepEqual(await recover(host.paseo, request, () => {}, read), data);
  assert.equal(reads, 1);
  for (const persistence of [
    { provider: "claude", sessionId, nativeHandle: "/host/session.jsonl" },
    { provider: "pi", sessionId, nativeHandle: "relative/session.jsonl" },
    { provider: "pi", sessionId, nativeHandle: "/host/arbitrary.txt" },
  ]) assert.equal(await recover(api(persistence).paseo, request, () => {}, read), null);
  assert.equal(reads, 1);
  assert.equal(await recover(host.paseo, request, () => {}, async () => { throw new Error("private file path"); }), null);
  assert.equal(await recover(host.paseo, request, () => {}, async () => {
    host.change({ provider: "pi", sessionId: "new-session", nativeHandle: "/host/new.jsonl" });
    return session;
  }), null);
});

test("oversized recovered previews are not sent through RPC", () => {
  const value = structuredClone(data);
  value.questions[0]!.options[0]!.preview = "x".repeat(1024 * 1024);
  assert.equal(parseSession(jsonl(call("call-node", null, value), answer("answer-node", "call-node", value)),
    sessionId, callId, nativeSummary(value)), null);
});

test("file reader uses bounded read-only access and closes handles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zeonest-question-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  await writeFile(path, session);
  assert.equal(await readSession(path), session);
  const file = await open(path, "r+");
  try { await file.truncate(MAX_SESSION_BYTES + 1); } finally { await file.close(); }
  assert.equal(await readSession(path), null);
  assert.equal(await readSession(directory), null);
  await assert.rejects(readSession(join(directory, "missing")));
});

test("RPC registers synchronously but refuses disabled, stopped and late requests", async () => {
  let handler!: (input: typeof request, context: { paseo: Pick<PaseoApi, "agents"> }) => Promise<Questionnaire | null>;
  const context = { handle(contract: { name: string }, callback: typeof handler) {
    assert.equal(contract.name, "zeonest.ask-user-question.recover");
    handler = callback;
  } } as unknown as PluginServerContext;
  const stopRpc = register(context);
  const host = api();
  await assert.rejects(handler(request, { paseo: host.paseo }), /未启用或已停止/);
  const stop = contribute(context);
  assert.throws(() => contribute(context), /已启动/);
  stop(); stop();
  await assert.rejects(handler(request, { paseo: host.paseo }), /未启用或已停止/);
  const stopAgain = contribute(context);
  stopRpc(); stopRpc();
  await assert.rejects(handler(request, { paseo: host.paseo }), /已停止/);
  stopAgain();

  const stopLive = contribute(context);
  register(context);
  let releaseRefresh!: () => void;
  const waiting = { agents: { ref: () => ({
    refresh: () => new Promise<null>((resolve) => { releaseRefresh = () => resolve(null); }),
  }) } } as unknown as Pick<PaseoApi, "agents">;
  const lateRpc = handler(request, { paseo: waiting });
  stopLive();
  const stopNew = contribute(context);
  releaseRefresh();
  await assert.rejects(lateRpc, /已停止/);
  stopNew();

  let release!: (value: string) => void;
  let stopped = false;
  const pending = recover(host.paseo, request, () => {
    // The caller's lifecycle generation must remain live throughout IO.
    if (stopped) throw new Error("stopped");
  }, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  stopped = true;
  release(session);
  await assert.rejects(pending, /stopped/);
});
