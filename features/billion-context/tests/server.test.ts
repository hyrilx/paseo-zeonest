import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type RequestListener } from "node:http";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { dashboardUrl } from "../shared/contracts";
import { preferencesSchema } from "../shared/settings";
import { listAgents, listWorkspaces, resolveTarget } from "../server/service";
import { readStatus } from "../server/http";
import { readPreferences } from "../server/configuration";
import contribute from "../server/index";
import contributeSettings from "../server/settings";

test("origins reject credentials, paths, injection and unsafe schemes; URLs encode actual IDs", () => {
  const defaults = preferencesSchema.parse({});
  assert.equal(defaults.serverOrigin, "http://127.0.0.1:8787");
  assert.equal(defaults.browserOrigin, "");
  for (const value of ["javascript:alert(1)", "file:///x", "http://u:secret@host", "http://host/__bili/", "http://host?x=1", "http://host#x", "http://host:0", "http://host:65536", "http://[::::]:1234", "http://999.999.999.999", "http://host\n.bad"]) {
    assert.equal(preferencesSchema.safeParse({ serverOrigin: value }).success, false, value);
  }
  assert.equal(preferencesSchema.parse({ serverOrigin: " https://host.test:443/// " }).serverOrigin, "https://host.test:443");
  assert.equal(preferencesSchema.parse({ serverOrigin: "http://[::1]:8787" }).serverOrigin, "http://[::1]:8787");
  assert.equal(dashboardUrl(defaults.serverOrigin), "http://127.0.0.1:8787/__bili/");
  assert.equal(dashboardUrl("https://dashboard", "actual /?#会话"), "https://dashboard/__bili/#/session/actual%20%2F%3F%23%E4%BC%9A%E8%AF%9D");
});
function fixture() {
  const agent: any = { id: "paseo-id", workspaceId: "w", persistence: { sessionId: "provider-id" }, archivedAt: null };
  const workspace: any = { id: "w", archivingAt: null };
  let current: any = agent;
  const handle = { refresh: async () => current ? { agent: current } : null };
  const paseo = { agents: { ref: () => handle }, workspaces: { ref: () => ({ refresh: async () => workspace }) } } as unknown as PluginHandlerContext["paseo"];
  const controller = new AbortController();
  const preferences = preferencesSchema.parse({ browserOrigin: "https://client.test" });
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
  mode = "timeout"; await assert.rejects(run(), /5 秒/);
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
    handle: (contract: { name: string }, callback: Function) => handlers.set(contract.name, callback) } as unknown as PluginServerContext;
  const stopSettings = contributeSettings(context);
  assert.ok(definition); assert.equal(handlers.size, 0);
  assert.equal((await readPreferences()).serverOrigin, "http://127.0.0.1:8787");
  const stop = contribute(context); assert.equal(handlers.size, 3); stop(); stop();
  const f = fixture();
  await assert.rejects(handlers.get("zeonest.billion-context.resolve")!({ workspaceId: "w" }, { paseo: f.paseo }), /已停止/);
  stopSettings(); await assert.rejects(readPreferences(), /尚未就绪/);
});
