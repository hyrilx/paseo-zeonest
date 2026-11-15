import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { createBridge, LEASE_MS } from "../server/bridge";
import { preferences, preferencesSchema } from "../shared/settings";
import { plainStatus, pillLabel } from "../shared/text";

export function post(env: Record<string, string>, packet: unknown, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(env.ZEONEST_PI_STATUS_URL!, { method: "POST", headers: { authorization: `Bearer ${env.ZEONEST_PI_STATUS_TOKEN}`, ...extra } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject); req.end(typeof packet === "string" ? packet : JSON.stringify(packet));
  });
}
const packet = (statuses = [{ key: "lens", text: "\u001b[32mReady\u001b[0m\nFull detail" }], sequence = 0) => ({ version: 1, sequence, statuses, warning: null });

test("defaults, action validation and Unicode labels", () => {
  assert.deepEqual(preferencesSchema.parse({}), { hiddenKeys: [], actions: [] });
  for (const command of ["oops", "/review\n/quit", "/review\0", "/review\r"]) assert.equal(preferencesSchema.safeParse({ actions: [{ key: "lens", command }] }).success, false);
  assert.equal(preferencesSchema.safeParse({ actions: [{ key: "lens", command: "/review:1 all" }] }).success, true);
  assert.equal(preferencesSchema.safeParse({ actions: [{ key: "x", command: "/a" }, { key: "x", command: "/b" }] }).success, false);
  assert.equal(pillLabel("key", "😀😀😀😀"), "😀😀😀😀");
  assert.equal(pillLabel("key", "\n"), "key");
  assert.equal(pillLabel("key", "long ".repeat(100)), "long ".repeat(100).trim());
  const old = { labelLength: 24, hiddenKeys: ["hidden"], actions: [{ key: "lens", command: "/lens" }] };
  assert.deepEqual(preferences.migrate!(old, 1), { hiddenKeys: old.hiddenKeys, actions: old.actions });
  assert.equal(plainStatus("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u001b[32mOK\u001b[0m\nnext"), "linkOK\nnext");
});

test("ingestion is authenticated, origin-restricted, bounded and isolated by agent", async (t) => {
  const bridge = createBridge(); t.after(() => bridge.close());
  const a = await bridge.open("a", "wa"); const b = await bridge.open("b", "wb");
  assert.equal(await post({ ...a, ZEONEST_PI_STATUS_TOKEN: "bad" }, packet()), 403);
  assert.equal(await post(a, packet(), { origin: "https://evil.test" }), 403);
  assert.equal(await post(a, "not JSON"), 400);
  assert.equal(await post(a, packet([{ key: "a", text: "x".repeat(65537) }])), 400);
  assert.equal(await post(a, packet()), 204);
  assert.equal(await post(b, packet([{ key: "lens", text: "B" }])), 204);
  const preferences = preferencesSchema.parse({ actions: [{ key: "lens", command: "/lens" }] });
  assert.deepEqual(bridge.snapshot(preferences).statuses.map((s) => [s.agentId, s.text, s.command]), [["a", "Ready\nFull detail", "/lens"], ["b", "B", "/lens"]]);
  assert.equal(bridge.snapshot({ ...preferences, hiddenKeys: ["lens"] }).statuses.length, 0);
  assert.equal(await post(a, packet([], 1)), 204);
  assert.deepEqual(bridge.snapshot(preferences).statuses.map((s) => s.agentId), ["b"]);
});

test("late packets cannot resurrect cleared state and session tokens rotate on reopen", async (t) => {
  const bridge = createBridge(); t.after(() => bridge.close());
  const old = await bridge.open("a", "w");
  await post(old, packet()); await post(old, packet([], 3)); await post(old, packet(undefined, 2));
  assert.equal(bridge.snapshot(preferencesSchema.parse({})).statuses.length, 0);
  const next = await bridge.open("a", "w");
  assert.notEqual(next.ZEONEST_PI_STATUS_TOKEN, old.ZEONEST_PI_STATUS_TOKEN);
  assert.equal(await post(old, packet()), 403);
  bridge.remove("a"); assert.equal(await post(next, packet()), 403);
});

test("leases hide stale content, reconnect restores it, warnings never look like success", async (t) => {
  let now = 0; const bridge = createBridge(() => now); t.after(() => bridge.close());
  const env = await bridge.open("a", "w");
  now = LEASE_MS + 1;
  assert.match(bridge.snapshot(preferencesSchema.parse({})).warnings[0]!.message, /尚未收到/);
  await post(env, packet());
  assert.equal(bridge.snapshot(preferencesSchema.parse({})).statuses.length, 1);
  now += LEASE_MS;
  assert.equal(bridge.snapshot(preferencesSchema.parse({})).statuses.length, 0);
  assert.match(bridge.snapshot(preferencesSchema.parse({})).warnings[0]!.message, /断开/);
  await post(env, { ...packet(undefined, 1), warning: "status too large" });
  assert.equal(bridge.snapshot(preferencesSchema.parse({})).warnings[0]!.message, "status too large");
  await bridge.close(); await bridge.close();
  await assert.rejects(bridge.open("b", "w"), /停止/);
  assert.throws(() => bridge.snapshot(preferencesSchema.parse({})), /停止/);
});

test("closing during lazy listen cannot leak a listener or create a late session", async () => {
  const bridge = createBridge(); const pending = bridge.open("a", "w"); const closed = bridge.close();
  await assert.rejects(pending, /停止/); await closed;
});
