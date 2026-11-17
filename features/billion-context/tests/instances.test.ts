import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { resolveInstances } from "../server/instances";
import { DashboardRequestError, readHealth, readManifest, readStatus } from "../server/http";

const manifest = { ok: true, proxy: "billion-context", version: "0.1.215" };
const origin = (index: number) => `http://127.0.0.1:${9000 + index}`;
const identity = (instanceId = "instance-a", pid = 123, startedAt = 1700000000000) => ({ ok: true, instanceId, pid, startedAt });
type Options = {
  origins?: string[]; conversationId?: string; manual?: string; selected?: string; key?: string; signal?: AbortSignal;
  lookup?: typeof readStatus; probe?: typeof readManifest; health?: typeof readHealth;
};
function run(options: Options = {}) {
  return resolveInstances(options.conversationId, options.manual ?? "", options.selected,
    options.signal ?? new AbortController().signal, options.lookup ?? (async () => ({ ok: true, sessionId: "exact" })),
    async () => options.origins ?? [origin(1)], options.probe ?? (async () => manifest), options.health ?? (async () => ({})), options.key);
}
test("an old live inline origin is still probed after more than sixteen stale startup records", async () => {
  const candidates = Array.from({ length: 96 }, (_, index) => origin(index));
  const seen: string[] = [];
  const matches = await run({ origins: candidates, conversationId: "provider-id", probe: async (candidate) => {
    seen.push(candidate);
    if (candidate !== candidates[90]) throw new DashboardRequestError("unreachable", "closed");
    return manifest;
  } });
  assert.equal(seen.length, 96); assert.deepEqual(matches, [{ origin: candidates[90], sessionId: "exact" }]);
});
test("the history pool stays bounded at 256 addresses rather than the sixteen visible choices", async () => {
  const candidates = Array.from({ length: 300 }, (_, index) => origin(index)); let count = 0;
  const matches = await run({ origins: candidates, probe: async (candidate) => {
    count++; return candidate === candidates[255] ? manifest : {};
  } });
  assert.equal(count, 256); assert.equal(matches[0]?.origin, candidates[255]);
});
test("aliases merge only when instance ID, PID and startup time all agree", async () => {
  const matches = await run({ origins: [origin(1), origin(2)], conversationId: "provider", health: async () => identity() });
  assert.equal(matches.length, 1); assert.equal(matches[0]?.origin, origin(1)); assert.equal(matches[0]?.pid, 123);
});
test("independent Pi processes stay distinct even when they read the same persisted exact session", async () => {
  for (const mode of ["id", "pid", "start"]) {
    const matches = await run({ origins: [origin(1), origin(2)], conversationId: "provider", health: async (candidate) => candidate === origin(1)
      ? identity() : identity(mode === "id" ? "instance-b" : "instance-a", mode === "pid" ? 456 : 123, mode === "start" ? 1700000000001 : 1700000000000) });
    assert.equal(matches.length, 2, mode); assert.ok(matches.every((match) => match.sessionId === "exact"));
  }
});
test("missing, invalid or unavailable health metadata never merges two origins", async () => {
  for (const payload of [{}, { ok: true, instanceId: "same", pid: 123 }, identity("same", 0), identity("same", 123, -1), identity("same", 123, 1e20)]) {
    const matches = await run({ origins: [origin(1), origin(2)], health: async () => payload });
    assert.equal(matches.length, 2); assert.equal(matches[0]?.pid, undefined);
  }
  assert.equal((await run({ origins: [origin(1), origin(2)], health: async () => { throw new Error("old version"); } })).length, 2);
});
test("a port reused by another instance invalidates the selected identity", async () => {
  const key = "instance-a/123/1700000000000";
  await assert.rejects(run({ selected: origin(1), key, conversationId: "provider", health: async () => identity("instance-b"),
    lookup: async () => assert.fail("a reused port must not receive the provider session ID") }), /实例身份已改变/);
  await assert.rejects(run({ selected: origin(1), key, health: async () => ({}) }), /无法验证/);
  await assert.rejects(run({ key }), /缺少对应地址/);
  assert.equal((await run({ selected: origin(1), key, health: async () => identity() })).length, 1);
});
test("contradictory mappings from aliases of one proven instance fail rather than choose a session", async () => {
  await assert.rejects(run({ origins: [origin(1), origin(2)], conversationId: "provider", health: async () => identity(),
    lookup: async (candidate) => ({ ok: true, sessionId: candidate === origin(1) ? "one" : "two" }) }), /不一致的会话映射/);
});
test("discovery reports timeout, absent conversation, pre-first-request and invalid mapping separately", async () => {
  const cases: [typeof readStatus, RegExp][] = [
    [async () => { throw new DashboardRequestError("timeout", "secret"); }, /请求超时/],
    [async () => { throw new DashboardRequestError("http", "secret", 404); }, /未收录当前 provider session ID/],
    [async () => ({ ok: true, sessionId: null, phase: "pre-first-request" }), /尚未建立压缩会话/],
    [async () => ({ ok: true, sessionId: "wrong", fallback: true }), /无效或非精确映射/],
    [async () => { throw new DashboardRequestError("invalid", "secret"); }, /无效或非精确映射/],
  ];
  for (const [lookup, expected] of cases) await assert.rejects(run({ conversationId: "provider", lookup }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, expected);
    assert.match(error.message, /不会打开最近会话/); assert.doesNotMatch(error.message, /secret/); return true;
  });
});
test("no record, dead port and a foreign service have different actionable errors", async () => {
  await assert.rejects(run({ origins: [] }), /没有发现 dashboard 地址/);
  await assert.rejects(run({ probe: async () => { throw new DashboardRequestError("unreachable", "secret"); } }), /历史地址无法连接/);
  let leaked = false;
  await assert.rejects(run({ conversationId: "provider", probe: async () => ({ ok: true, proxy: "another-app", version: "1" }),
    health: async () => { leaked = true; return {}; }, lookup: async () => { leaked = true; return {}; } }), /标识校验/);
  assert.equal(leaked, false);
});
test("all exact-match requests get five seconds, rather than the old one-second auto deadline", async () => {
  await run({ conversationId: "provider", probe: async (_origin, _signal, timeout) => { assert.equal(timeout, 2000); return manifest; },
    health: async (_origin, _signal, timeout) => { assert.equal(timeout, 2000); return identity(); },
    lookup: async (_origin, id, _signal, timeout) => { assert.equal(id, "provider"); assert.equal(timeout, 5000); return { ok: true, sessionId: "exact" }; } });
});
test("more than sixteen distinct live instances require pinning, never silent truncation", async () => {
  await assert.rejects(run({ origins: Array.from({ length: 17 }, (_, index) => origin(index)) }), /超过 16 个可用实例/);
});
test("the total discovery deadline aborts workers and never opens a partial apparent unique match", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  let started!: () => void; const ready = new Promise<void>((yes) => { started = yes; });
  let aborted = 0;
  const pending = run({ origins: [origin(1), origin(2)], probe: async (candidate, signal) => {
    if (candidate === origin(1)) return manifest;
    started(); return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(new Error("abort")); }, { once: true }));
  } });
  await ready; t.mock.timers.tick(12000);
  await assert.rejects(pending, /达到 12 秒时限/); assert.equal(aborted, 1);
});
test("feature cleanup cancels lookup and late results cannot survive shutdown", async () => {
  const controller = new AbortController(); let signalSeen: AbortSignal | undefined;
  await assert.rejects(run({ signal: controller.signal, conversationId: "provider", lookup: async (_origin, _id, signal) => {
    signalSeen = signal; controller.abort(); return { ok: true, sessionId: "exact" };
  } }), /已停止/);
  assert.equal(signalSeen?.aborted, true);
});
test("real manifest, health and exact status requests preserve identity and deduplicate aliases", async (t) => {
  const seen: string[] = [];
  async function listener() {
    const instance = createServer((req, res) => {
      seen.push(req.url!); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
      if (req.url === "/__bili/plugin/manifest") res.end(JSON.stringify(manifest));
      else if (req.url === "/__bili/health") res.end(JSON.stringify(identity()));
      else if (req.url === "/__bili/plugin/status?conversationId=provider+%2F%3F%23") res.end(JSON.stringify({ ok: true, sessionId: "exact" }));
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((yes) => instance.listen(0, "127.0.0.1", yes));
    t.after(async () => { instance.closeAllConnections(); await new Promise<void>((yes) => instance.close(() => yes())); });
    const address = instance.address(); assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  }
  const candidates = [await listener(), await listener()];
  const matches = await run({ origins: candidates, conversationId: "provider /?#", probe: readManifest, health: readHealth, lookup: readStatus });
  assert.equal(matches.length, 1); assert.equal(matches[0]?.instanceId, "instance-a"); assert.equal(matches[0]?.sessionId, "exact");
  assert.equal(seen.length, 6); assert.equal(seen.filter((path) => path === "/__bili/health").length, 2);
});
