import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createPreload, observerEnvironment, providerNodeOptions } from "../server/preload";
import { preloadSource } from "../server/preload-source";
import { executeExpansion } from "../server/actions";
import type { Bridge } from "../server/bridge";
import { preferencesSchema } from "../shared/settings";
import { setPreferencesReader } from "../server/configuration";
import contribute from "../server/index";
import contributeSettings from "../server/settings";

async function home(t: { after(fn: () => Promise<void>): void }) {
  const path = await mkdtemp(join(tmpdir(), "zeonest-status-")); t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test("automatic preload preparation is atomic, idempotent and never overwrites edits", async (t) => {
  const setup = createPreload(await home(t));
  const paths = await Promise.all(Array.from({ length: 8 }, () => setup.prepare()));
  const path = paths[0]!; assert.ok(paths.every((value) => value === path));
  assert.equal(await readFile(path, "utf8"), preloadSource);
  await setup.prepare(); await writeFile(path, "personal code");
  await assert.rejects(setup.prepare(), /改变/);
  assert.equal(await readFile(path, "utf8"), "personal code");
});
test("preload preparation rejects symlink directories and files", async (t) => {
  const directory = await home(t); const destination = join(directory, "destination"); await mkdir(destination);
  await symlink(destination, join(directory, ".zeonest"));
  await assert.rejects(createPreload(directory).prepare(), /普通目录/);
  await rm(join(directory, ".zeonest"));
  const setup = createPreload(directory); const path = await setup.prepare(); await rm(path);
  await symlink(join(destination, "target"), path);
  await assert.rejects(setup.prepare(), /普通观察器/);
});

test("injection preserves effective Node options, quotes paths and replaces only its own duplicate", () => {
  const channel = { ZEONEST_PI_STATUS_URL: "http://127.0.0.1:1/snapshot", ZEONEST_PI_STATUS_TOKEN: "token" };
  const path = join(tmpdir(), 'a space # and "quote"', "observer.mjs");
  const first = observerEnvironment(path, channel, { KEEP: "yes", NODE_OPTIONS: "--trace-warnings" }, "--no-warnings");
  assert.equal(first.KEEP, "yes"); assert.match(first.NODE_OPTIONS, /^--trace-warnings --import=/);
  assert.ok(first.NODE_OPTIONS.includes("%20")); assert.ok(first.NODE_OPTIONS.includes("%23"));
  assert.deepEqual(observerEnvironment(path, channel, first), first);
  assert.match(observerEnvironment(path, channel, {}, "--no-warnings").NODE_OPTIONS, /^--no-warnings /);
  assert.equal(providerNodeOptions({ NODE_OPTIONS: "" }), "");
  assert.equal(providerNodeOptions({ OTHER: "yes" }), undefined);
  assert.throws(() => providerNodeOptions({ NODE_OPTIONS: 42 }));
});

function actionFixture() {
  const calls: string[] = [];
  const current = { provider: "pi", workspaceId: "w", status: "idle", archivedAt: null, activeTurn: null, pendingPermissions: [] };
  let commands = { error: null as string | null, commands: [{ name: "lens", kind: "command" }] };
  let alive = true;
  const agent = { refresh: async () => { calls.push("refresh"); }, current: () => current,
    commands: async () => { calls.push("commands"); return commands; }, send: async (command: string) => { calls.push(command); } };
  const context = { paseo: { agents: { ref: () => agent } } } as unknown as PluginHandlerContext;
  const bridge = { snapshot: () => ({ statuses: [{ agentId: "a", workspaceId: "w", key: "lens", command: "/lens detail" }] }) } as unknown as Bridge;
  const run = (command = "/lens detail") => executeExpansion({ agentId: "a", key: "lens", command }, context, bridge, preferencesSchema.parse({}), () => alive);
  return { current, calls, agent, run, setCommands: (value: typeof commands) => { commands = value; }, stop: () => { alive = false; } };
}
test("expansion only sends the exact mapped loaded command to an idle Pi agent", async () => {
  const f = actionFixture(); assert.match((await f.run()).message, /已发送/);
  assert.deepEqual(f.calls, ["refresh", "commands", "refresh", "/lens detail"]);
  await assert.rejects(f.run("/different"), /改变/);
});
test("busy, missing/skill commands, discovery errors and stopped actions cannot send", async () => {
  for (const mode of ["running", "missing", "skill", "error", "stopped", "late-busy", "other-provider"]) {
    const f = actionFixture();
    if (mode === "running") f.current.status = "running";
    if (mode === "missing") f.setCommands({ error: null, commands: [] });
    if (mode === "skill") f.setCommands({ error: null, commands: [{ name: "lens", kind: "skill" }] });
    if (mode === "error") f.setCommands({ error: "offline", commands: [] });
    if (mode === "stopped") f.stop();
    if (mode === "other-provider") f.current.provider = "codex";
    if (mode === "late-busy") f.agent.commands = async () => { f.current.status = "running"; return { error: null, commands: [{ name: "lens", kind: "command" }] }; };
    await assert.rejects(f.run()); assert.equal(f.calls.includes("/lens detail"), false, mode);
  }
});
test("native hooks are business-only, skip non-Pi/history, preserve env and are cleaned up", async (t) => {
  const hooks = new Map<string, Function>(); const handlers = new Map<string, Function>();
  const server = { addHook: (name: string, callback: Function) => { hooks.set(name, callback); return () => { hooks.delete(name); }; },
    handle: (contract: { name: string }, callback: Function) => handlers.set(contract.name, callback) } as unknown as PluginServerContext;
  const removeReader = setPreferencesReader(async () => preferencesSchema.parse({}));
  const cleanup = contribute(server, createPreload(await home(t)));
  try {
    const base = { agentId: "a", workspaceId: "w", purpose: "interactive", provider: "pi", env: { EXISTING: "keep" } };
    const request = { ...base }; const ctx = { signal: new AbortController().signal, paseo: { config: { get: async () => ({ config: { providers: { pi: { env: { NODE_OPTIONS: "--trace-warnings" } } } } }) } } };
    await hooks.get("agent.open.before")!({ request }, ctx);
    assert.equal(request.env.EXISTING, "keep"); assert.ok("ZEONEST_PI_STATUS_URL" in request.env);
    assert.match((request.env as Record<string, string>).NODE_OPTIONS!, /^--trace-warnings --import=/);
    for (const patch of [{ provider: "codex" }, { purpose: "history" }, { workspaceId: null }]) {
      const skipped = { ...base, ...patch, env: {} };
      await hooks.get("agent.open.before")!({ request: skipped }, ctx); assert.deepEqual(skipped.env, {});
    }
    assert.equal((await handlers.get("zeonest.pi-status-bridge.list")!()).statuses.length, 0);
  } finally { await cleanup!(); removeReader(); }
  assert.equal(hooks.size, 0);
  await assert.rejects(handlers.get("zeonest.pi-status-bridge.list")!());
});
test("failed preparation, aborts and cleanup during injection leave the original launch environment untouched", async () => {
  for (const mode of ["failure", "aborted", "cleanup", "options", "config-failure"]) {
    const hooks = new Map<string, Function>();
    const server = { addHook: (name: string, callback: Function) => { hooks.set(name, callback); return () => hooks.delete(name); }, handle() {} } as unknown as PluginServerContext;
    let release!: (path: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    let prepares = 0, configReads = 0;
    const cleanup = contribute(server, { prepare: async () => { prepares++; if (mode === "failure") throw new Error("private detail"); return mode === "cleanup" ? pending : "/observer.mjs"; } });
    const controller = new AbortController(); if (mode === "aborted") controller.abort();
    const original = mode === "config-failure" ? { KEEP: "yes" } : { KEEP: "yes", NODE_OPTIONS: "--trace-warnings" };
    const request = { agentId: "a", workspaceId: "w", provider: "pi", purpose: "interactive", env: original };
    const context = { signal: controller.signal, paseo: { config: { get: async () => { configReads++; throw new Error("config unavailable"); } } } };
    const opening = hooks.get("agent.open.before")!({ request }, context);
    if (mode === "cleanup") { await cleanup!(); release("/observer.mjs"); }
    await opening;
    if (mode === "options") {
      assert.notEqual(request.env, original); assert.match(request.env.NODE_OPTIONS!, /^--trace-warnings --import=/);
    } else assert.equal(request.env, original, mode);
    assert.equal(configReads, mode === "config-failure" ? 1 : 0);
    assert.equal(prepares, ["aborted", "config-failure"].includes(mode) ? 0 : 1);
    await cleanup!();
  }
});

test("always-available settings registration neither prepares files nor registers setup RPCs", () => {
  const methods: string[] = [];
  const server = { registerSettings: () => { methods.push("settings"); return {}; }, handle: (contract: { name: string }) => { methods.push(contract.name); } } as unknown as PluginServerContext;
  const cleanup = contributeSettings(server);
  assert.deepEqual(methods, ["settings"]);
  cleanup!();
});
