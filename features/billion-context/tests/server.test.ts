import assert from "node:assert/strict";
import { fakeManager } from "./fixtures/managed";
import test from "node:test";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { dashboardUrl } from "../shared/contracts";
import { preferencesSchema } from "../shared/settings";
import { listAgents, listWorkspaces, resolveTarget as resolveTargetImpl } from "../server/service";
import { readManifest, readStatus } from "../server/http";
import { discoverOrigins } from "../server/discovery";
import { readPreferences } from "../server/configuration";
import contribute from "../server/index";
import contributeRpc from "../server/rpc";
import contributeSettings from "../server/settings";

// These service tests inject no health identity; do not contact arbitrary local fixture ports.
const resolveTarget: typeof resolveTargetImpl = (...args) => resolveTargetImpl(
  args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7] ?? (async () => ({})),
);

test("origins reject credentials, paths, injection and unsafe schemes; URLs encode actual IDs", () => {
  const defaults = preferencesSchema.parse({});
  assert.equal(defaults.serverOrigin, "");
  assert.equal(preferencesSchema.parse({ serverOrigin: "   ", browserOrigin: " " }).serverOrigin, "");
  assert.equal(defaults.browserOrigin, "");
  for (const value of ["javascript:alert(1)", "file:///x", "http://u:secret@host", "http://host/__bili/", "http://host?x=1", "http://host#x", "http://host:0", "http://host:65536", "http://[::::]:1234", "http://999.999.999.999", "http://host\n.bad"]) {
    assert.equal(preferencesSchema.safeParse({ serverOrigin: value }).success, false, value);
  }
  assert.equal(preferencesSchema.parse({ serverOrigin: " https://host.test:443/// " }).serverOrigin, "https://host.test:443");
  assert.equal(preferencesSchema.parse({ serverOrigin: "http://[::1]:8787" }).serverOrigin, "http://[::1]:8787");
  assert.equal(dashboardUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787/__bili/");
  assert.equal(dashboardUrl("https://dashboard", "actual /?#会话"), "https://dashboard/__bili/#/session/actual%20%2F%3F%23%E4%BC%9A%E8%AF%9D");
});
function fixture() {
  const agent: any = { id: "paseo-id", workspaceId: "w", persistence: { sessionId: "provider-id" }, archivedAt: null };
  const workspace: any = { id: "w", archivingAt: null };
  let current: any = agent;
  const handle = { refresh: async () => current ? { agent: current } : null };
  const paseo = { agents: { ref: () => handle }, workspaces: { ref: () => ({ refresh: async () => workspace }) } } as unknown as PluginHandlerContext["paseo"];
  const controller = new AbortController();
  const preferences = preferencesSchema.parse({ serverOrigin: "http://127.0.0.1:8787", browserOrigin: "https://client.test" });
  return { agent, workspace, handle, paseo, controller, preferences, change(value: any) { current = value; } };
}
test("detail uses provider identity then returned billion-context identity, not Paseo UUID", async () => {
  const f = fixture(); const calls: unknown[] = [];
  const result = await resolveTarget(f.paseo, { workspaceId: "w", agentId: "paseo-id" }, f.preferences, f.controller.signal,
    async (...args) => { calls.push(args); return { ok: true, sessionId: "actual/bili", conversationId: "canonical-id" }; });
  assert.equal((calls[0] as unknown[])[1], "provider-id");
  assert.equal((calls[0] as unknown[])[0], f.preferences.serverOrigin);
  assert.equal(result.url, "https://client.test/__bili/#/session/actual%2Fbili");
  assert.equal(result.workspaceId, "w");
});
test("overview never reads agent identity or calls status", async () => {
  const f = fixture();
  const result = await resolveTarget(f.paseo, { workspaceId: "w" }, f.preferences, f.controller.signal, async () => { throw new Error("unexpected"); });
  assert.equal(result.url, "https://client.test/__bili/");
});
test("missing, archived, wrong-workspace or identity-less agents do not guess", async () => {
  for (const mode of ["missing", "archived", "other-workspace", "internal", "no-session", "archived-workspace"]) {
    const f = fixture();
    if (mode === "missing") f.change(null);
    if (mode === "archived") f.agent.archivedAt = "now";
    if (mode === "other-workspace") f.agent.workspaceId = "other";
    if (mode === "internal") f.agent.internal = true;
    if (mode === "no-session") f.agent.persistence = null;
    if (mode === "archived-workspace") f.workspace.archivingAt = "now";
    await assert.rejects(resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, f.preferences, f.controller.signal, async () => { assert.fail(mode); }));
  }
});
test("null session, invalid output and latest fallback never navigate", async () => {
  for (const payload of [{ ok: true, sessionId: null }, { ok: false, sessionId: "wrong" }, { ok: true, sessionId: "wrong", fallback: true }, {}]) {
    const f = fixture();
    await assert.rejects(resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, f.preferences, f.controller.signal, async () => payload), /不会打开最近会话/);
  }
});
test("identity changes and cleanup during lookup discard the result", async () => {
  for (const mode of ["changed", "archived", "stopped"]) {
    const f = fixture();
    await assert.rejects(resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, f.preferences, f.controller.signal, async () => {
      if (mode === "changed") f.change({ ...f.agent, persistence: { sessionId: "new" } });
      if (mode === "archived") f.agent.archivedAt = "now";
      if (mode === "stopped") f.controller.abort();
      return { ok: true, sessionId: "old" };
    }));
  }
});
const manifest = { ok: true, proxy: "billion-context", version: "0.1.215" };
const origins = ["http://127.0.0.1:9001", "http://127.0.0.1:9002", "http://127.0.0.1:9003"];
test("auto overview validates manifests, ignores stale ports and never sends a conversation ID", async () => {
  const f = fixture(); const probed: string[] = [];
  const result = await resolveTarget(f.paseo, { workspaceId: "w" }, preferencesSchema.parse({}), f.controller.signal,
    async () => assert.fail("overview must not read status"), async () => origins,
    async (origin, _signal, timeout) => {
      probed.push(origin); assert.equal(timeout, 2000);
      if (origin === origins[0]) throw new Error("old process exited");
      return origin === origins[1] ? manifest : { ok: true, proxy: "another-app", version: "1" };
    });
  assert.deepEqual(probed, origins);
  assert.equal(result.url, origins[1] + "/__bili/");
});
test("auto detail checks manifest before identity lookup and only returns exact session matches", async () => {
  const f = fixture(); const calls: unknown[] = [];
  const result = await resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, preferencesSchema.parse({}), f.controller.signal,
    async (origin, conversationId, _signal, timeout) => {
      calls.push({ origin, conversationId, timeout });
      return origin === origins[1] ? { ok: true, sessionId: "canonical/bili" } : { ok: true, sessionId: "wrong", fallback: true };
    }, async () => origins, async (origin) => origin === origins[0] ? { ok: true, proxy: "foreign", version: "1" } : manifest);
  assert.deepEqual(calls, origins.slice(1).map((origin) => ({ origin, conversationId: "provider-id", timeout: 5000 })));
  assert.equal(result.url, origins[1] + "/__bili/#/session/canonical%2Fbili");
});
test("multiple exact matches require choice; selection repeats discovery, manifest and exact session validation", async () => {
  const f = fixture(); const preferences = preferencesSchema.parse({ browserOrigin: "https://client.test:{port}" });
  const input = { workspaceId: "w", agentId: "a" };
  const lookup: typeof readStatus = async (_origin, _id, _signal, timeout) => {
    assert.equal(timeout, 5000); return { ok: true, sessionId: "same/bili" };
  };
  const choices = await resolveTarget(f.paseo, input, preferences, f.controller.signal, lookup, async () => origins, async () => manifest);
  assert.deepEqual(choices.instances, origins); assert.equal(choices.workspaceId, "w"); assert.equal(choices.url, undefined);
  assert.deepEqual(choices.instanceDetails?.map(({ origin }) => origin), origins);
  const selected = await resolveTarget(f.paseo, { ...input, instanceOrigin: origins[1] }, preferences, f.controller.signal,
    async (origin, id, _signal, timeout) => { assert.equal(origin, origins[1]); assert.equal(id, "provider-id"); assert.equal(timeout, 5000); return { ok: true, sessionId: "same/bili" }; },
    async () => origins, async (origin) => { assert.equal(origin, origins[1]); return manifest; });
  assert.equal(selected.url, "https://client.test:9002/__bili/#/session/same%2Fbili");
  await assert.rejects(resolveTarget(f.paseo, { ...input, instanceOrigin: origins[1] }, preferences, f.controller.signal,
    async () => assert.fail("stale choice must not get identity"), async () => [origins[0]!], async () => assert.fail()), /实例记录已改变/);
  await assert.rejects(resolveTarget(f.paseo, { ...input, instanceOrigin: "http://attacker.test" }, preferences, f.controller.signal,
    async () => assert.fail(), async () => origins, async () => assert.fail()), /实例记录已改变/);
});
test("service returns validated process identities and rejects a port reused after selection", async () => {
  const f = fixture(); const preferences = preferencesSchema.parse({});
  const lookup: typeof readStatus = async () => ({ ok: true, sessionId: "shared-exact-session" });
  const health = async (origin: string) => ({ ok: true, instanceId: origin === origins[0] ? "one" : "two", pid: origin === origins[0] ? 123 : 456, startedAt: 1700000000000 });
  const choices = await resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, preferences, f.controller.signal,
    lookup, async () => origins.slice(0, 2), async () => manifest, health);
  assert.deepEqual(choices.instanceDetails?.map(({ pid }) => pid), [123, 456]);
  await assert.rejects(resolveTarget(f.paseo, { workspaceId: "w", agentId: "a", instanceOrigin: origins[0], instanceKey: "one/123/1700000000000" },
    preferences, f.controller.signal, async () => assert.fail("changed identity must not receive the provider session ID"),
    async () => origins, async () => manifest, async () => ({ ...await health(origins[0]!), instanceId: "restarted" })), /实例身份已改变/);
});
test("manual origins retain precedence and do not read files or probe other services", async () => {
  const f = fixture();
  const result = await resolveTarget(f.paseo, { workspaceId: "w" }, f.preferences, f.controller.signal,
    async () => assert.fail(), async () => assert.fail("manual does not discover"), async () => assert.fail("manual is explicitly trusted"));
  assert.equal(result.url, "https://client.test/__bili/");
});
test("auto failure and shutdown never fall back to another conversation", async () => {
  for (const mode of ["empty", "null-session", "fallback", "failed-manifest", "stopped"]) {
    const f = fixture();
    await assert.rejects(resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, preferencesSchema.parse({}), f.controller.signal,
      async () => { if (mode === "stopped") f.controller.abort(); return { ok: true, sessionId: mode === "null-session" ? null : "wrong", fallback: mode === "fallback" }; },
      async () => mode === "empty" ? [] : origins, async () => mode === "failed-manifest" ? {} : manifest),
    mode === "stopped" ? /已停止/ : /不会打开最近会话/);
  }
});
test("auto discovery has at most eight concurrent probes and ignores results after identity changes", async () => {
  const f = fixture(); let concurrent = 0, peak = 0;
  const candidates = Array.from({ length: 16 }, (_, index) => `http://127.0.0.1:${9100 + index}`);
  const result = await resolveTarget(f.paseo, { workspaceId: "w" }, preferencesSchema.parse({}), f.controller.signal,
    async () => assert.fail(), async () => candidates, async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise((yes) => setTimeout(yes, 2)); concurrent--; return manifest;
    });
  assert.equal(peak, 8); assert.deepEqual(result.instances, candidates);
  await assert.rejects(resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, preferencesSchema.parse({}), f.controller.signal,
    async () => { f.change({ ...f.agent, persistence: { sessionId: "new-session" } }); return { ok: true, sessionId: "old" }; },
    async () => [origins[0]!], async () => manifest), /当前会话已改变/);
});
test("client port templates validate only the port slot and expand after the instance is resolved", async () => {
  for (const browserOrigin of ["http://client.test:{port}", "https://[::1]:{port}", "https://localhost:{port}///"]) {
    assert.ok(preferencesSchema.safeParse({ browserOrigin }).success, browserOrigin);
  }
  for (const browserOrigin of ["http://{host}:{port}", "http://{port}.test", "http://host:{unknown}", "http://host:{port}/path", "http://host:12{port}", "http://host:{port}?x=1", "http://u:p@host:{port}", "http://host:{port}:{port}", "javascript:{port}"]) {
    assert.equal(preferencesSchema.safeParse({ browserOrigin }).success, false, browserOrigin);
  }
  assert.equal(preferencesSchema.safeParse({ serverOrigin: "http://localhost:{port}" }).success, false);
  for (const [serverOrigin, expectedPort] of [["http://localhost:5678", "5678"], ["http://localhost", "80"], ["https://localhost", "443"]]) {
    const f = fixture();
    const preferences = preferencesSchema.parse({ serverOrigin, browserOrigin: "https://client.test:{port}" });
    const value = await resolveTarget(f.paseo, { workspaceId: "w" }, preferences, f.controller.signal);
    assert.equal(value.url, `https://client.test:${expectedPort}/__bili/`);
    assert.equal(preferences.browserOrigin, "https://client.test:{port}");
  }
});
test("lists paginate fully and filter archived/internal entries; stopped lists never start IO", async () => {
  const cursors: unknown[] = [];
  const paseo: any = { agents: { list: async ({ page }: any) => {
    cursors.push(page.cursor);
    return { entries: [{ agent: { id: page.cursor ?? "first", workspaceId: "w" } }, { agent: { id: "hidden", workspaceId: "w", internal: true } }],
      pageInfo: page.cursor ? { hasMore: false } : { hasMore: true, nextCursor: "next" } };
  } }, workspaces: { list: async () => ({ entries: [{ id: "w", title: "Title", name: "Name" }, { id: "old", archivingAt: "now" }], pageInfo: { hasMore: false } }) } };
  assert.deepEqual(await listAgents(paseo, () => true), [{ agentId: "first", workspaceId: "w" }, { agentId: "next", workspaceId: "w" }]);
  assert.deepEqual(cursors, [undefined, "next"]);
  assert.deepEqual(await listWorkspaces(paseo, () => true), [{ id: "w", name: "Title" }]);
  await assert.rejects(listAgents(paseo, () => false), /已停止/);
  assert.equal(cursors.length, 2);
  paseo.workspaces.list = async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "same" } });
  await assert.rejects(listWorkspaces(paseo, () => true), /游标无效/);
});
async function server(t: { after(fn: () => Promise<void>): void }, handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>((yes) => instance.listen(0, "127.0.0.1", yes));
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>((yes) => instance.close(() => yes())); });
  const address = instance.address(); assert.ok(address && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}
test("inline startup log through real manifest/status HTTP produces a templated exact session link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zeonest-billion-inline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const origin = await server(t, (req, res) => {
    requests.push(req.url!);
    if (req.url === "/__bili/plugin/manifest") res.end(JSON.stringify(manifest));
    else if (req.url === "/__bili/plugin/status?conversationId=provider-id") res.end(JSON.stringify({ ok: true, sessionId: "actual/bili" }));
    else { res.writeHead(404); res.end(); }
  });
  await writeFile(join(root, "bili.log"), `[inline] web UI listening on ${origin} (loopback only)\n`);
  const f = fixture();
  const value = await resolveTarget(f.paseo, { workspaceId: "w", agentId: "a" }, preferencesSchema.parse({ browserOrigin: "https://client.test:{port}" }),
    f.controller.signal, readStatus, (signal) => discoverOrigins(signal, root));
  assert.equal(value.url, "https://client.test:" + origin.split(":").at(-1) + "/__bili/#/session/actual%2Fbili");
  assert.deepEqual(requests, ["/__bili/plugin/manifest", "/__bili/plugin/status?conversationId=provider-id"]);
});
test("manifest probing sends no session ID, cookies or authorization", async (t) => {
  const origin = await server(t, (req, res) => {
    assert.equal(req.url, "/__bili/plugin/manifest");
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
    res.end(JSON.stringify(manifest));
  });
  assert.deepEqual(await readManifest(origin, new AbortController().signal), manifest);
});
test("HTTP sends only exact conversation query and no latest fallback or authorization", async (t) => {
  const origin = await server(t, (req, res) => {
    assert.equal(req.url, "/__bili/plugin/status?conversationId=provider+%2F%3F%23");
    assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({ ok: true, sessionId: "bili" }));
  });
  assert.deepEqual(await readStatus(origin, "provider /?#", new AbortController().signal), { ok: true, sessionId: "bili" });
});
test("HTTP failures, redirects, oversized/invalid responses and deadlines are bounded", async (t) => {
  let mode = "404"; let redirected = 0;
  const origin = await server(t, (_req, res) => {
    if (mode === "404") { res.writeHead(404); res.end("secret upstream body"); }
    if (mode === "redirect") { redirected++; res.writeHead(302, { location: "/elsewhere" }); res.end(); }
    if (mode === "bad") res.end("<html>not json</html>");
    if (mode === "large") res.end("x".repeat(262145));
    // timeout deliberately leaves response open
  });
  const run = () => readStatus(origin, "s", new AbortController().signal, 30);
  await assert.rejects(run(), /未找到当前会话/);
  mode = "redirect"; await assert.rejects(run(), /HTTP 302/); assert.equal(redirected, 1);
  mode = "bad"; await assert.rejects(run(), /有效 JSON/);
  mode = "large"; await assert.rejects(run());
  mode = "timeout"; await assert.rejects(run(), /请求时限/);
});
test("abort stops an active dashboard request", async (t) => {
  const origin = await server(t, () => {});
  const controller = new AbortController();
  const pending = readStatus(origin, "s", controller.signal);
  controller.abort();
  await assert.rejects(pending, /已停止/);
});
test("settings register while disabled; business handlers guard cleanup", async () => {
  let definition: unknown; const handlers = new Map<string, Function>();
  const context = { registerSettings: (value: unknown) => { definition = value; return { read: async () => ({ status: "ready", values: preferencesSchema.parse({}) }) }; },
    handle: (contract: { name: string }, callback: Function) => handlers.set(contract.name, callback),
    addHook: () => () => {} } as unknown as PluginServerContext;
  const stopSettings = contributeSettings(context, fakeManager().manager);
  assert.ok(definition); assert.equal(handlers.size, 2);
  assert.equal((await readPreferences()).serverOrigin, "");
  const stopRpc = contributeRpc(context);
  const published = new Set(handlers.keys());
  assert.equal(published.size, 5);
  const businessHandlers = () => [...handlers].filter(([name]) => !name.includes(".service.")).map(([, handler]) => handler);
  const unavailable = { paseo: new Proxy({}, { get() { assert.fail("disabled RPC performed business IO"); } }) };
  for (const handler of businessHandlers()) await assert.rejects(async () => handler({ workspaceId: "w" }, unavailable), /未启用或已停止/);
  const stop = contribute(context);
  assert.deepEqual(new Set(handlers.keys()), published);
  assert.deepEqual(await handlers.get("zeonest.billion-context.workspaces")!({}, { paseo: { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } }), []);
  await stop(); await stop();
  for (const handler of businessHandlers()) await assert.rejects(async () => handler({ workspaceId: "w" }, unavailable), /已停止/);
  // A stale declaration cannot attach to a later activation after its own cleanup.
  stopRpc(); const stopAgain = contribute(context);
  await assert.rejects(async () => handlers.get("zeonest.billion-context.agents")!({}, unavailable), /已停止/);
  await stopAgain(); await stopSettings(); await assert.rejects(readPreferences(), /尚未就绪/);
});
