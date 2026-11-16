import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import contribute from "../server/index";
import { activeBridge } from "../server/activation";
import { createBridge } from "../server/bridge";
import { createPreload, observerEnvironment } from "../server/preload";
import { preferencesSchema } from "../shared/settings";

type TestContext = { after(fn: () => Promise<void>): void };
async function until(check: () => boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("Timed out"); await delay(20); }
}
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'zeonest observer # "quote"-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function capture(t: TestContext, child: ChildProcessWithoutNullStreams) {
  const stdout: Buffer[] = []; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout.push(Buffer.from(chunk)); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; });
  return { child, closed, output: () => Buffer.concat(stdout).toString("utf8"), errors: () => stderr };
}
async function launch(t: TestContext, channel: Record<string, string> = {}, extraEnv: Record<string, string> = {}) {
  const home = await directory(t); const path = await createPreload(home).prepare();
  const env = observerEnvironment(path, channel, { ...extraEnv }, "--trace-warnings");
  const child = spawn(process.execPath, [new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname, "--mode", "rpc", "a b"], { env: { ...process.env, ...env }, stdio: "pipe" });
  return { ...capture(t, child), path, env };
}
const preferences = preferencesSchema.parse({});

test("native session hook result launches a Node observer that connects and forwards status", async (t) => {
  const home = await directory(t);
  const hooks = new Map<string, Function>();
  const server = { addHook: (name: string, callback: Function) => {
    hooks.set(name, callback); return () => { hooks.delete(name); };
  } } as unknown as PluginServerContext;
  const cleanup = contribute(server, createPreload(home)); t.after(async () => { await cleanup(); });
  const request: PluginSessionOpenRequest = {
    agentId: "hook-agent", workspaceId: "w", provider: "pi", cwd: home,
    reason: "create", purpose: "interactive", title: null, labels: {}, tools: [], mcpServers: {},
    env: { NODE_OPTIONS: "--trace-warnings", KEEP: "yes" },
  };
  // Match the host boundary: only the returned request survives the cloned hook input.
  const result = await hooks.get("agent.open.before")!({ request: structuredClone(request) }, { signal: new AbortController().signal });
  const opened: PluginSessionOpenRequest = result === undefined ? request : structuredClone(result);
  assert.deepEqual(request.env, { NODE_OPTIONS: "--trace-warnings", KEEP: "yes" });
  assert.ok(opened.env.ZEONEST_PI_STATUS_PRELOAD, "The actual launch environment must include the observer");
  assert.equal(opened.env.KEEP, "yes");
  const f = capture(t, spawn(process.execPath, [new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname, "--mode", "rpc"], {
    cwd: home, env: { ...process.env, ...opened.env }, stdio: "pipe",
  }));
  const bridge = activeBridge().bridge;
  await until(() => bridge.snapshot(preferences).statuses.length === 1);
  const snapshot = bridge.snapshot(preferences);
  assert.equal(snapshot.statuses[0]!.agentId, "hook-agent");
  assert.match(snapshot.statuses[0]!.text, /^😀分析/); assert.deepEqual(snapshot.warnings, []);
  f.child.stdin.write("update\n");
  await until(() => bridge.snapshot(preferences).statuses[0]?.text === "Updated detail");
  f.child.stdin.write("exit\n"); assert.equal((await f.closed).code, 7); assert.equal(f.errors(), "");
});

test("preload captures first status, deletion and fragmented UTF-8 without changing RPC bytes, arguments or stdin", async (t) => {
  const bridge = createBridge(); t.after(() => bridge.close());
  const f = await launch(t, await bridge.open("a", "w"));
  await until(() => bridge.snapshot(preferences).statuses.length === 1);
  assert.match(bridge.snapshot(preferences).statuses[0]!.text, /^😀分析\nlong/);
  const firstLine = JSON.parse(f.output().split("\n")[0]!);
  assert.deepEqual(firstLine.args, ["--mode", "rpc", "a b"]);
  assert.equal(firstLine.tokenInherited, false);
  assert.equal(JSON.parse(f.output().split("\n")[1]!).id, "unchanged");
  assert.equal(JSON.parse(f.output().split("\n")[1]!).statusText, bridge.snapshot(preferences).statuses[0]!.text);
  f.child.stdin.write("normal rpc input\nupdate\n");
  await until(() => bridge.snapshot(preferences).statuses[0]?.text === "Updated detail");
  assert.match(f.output(), /normal rpc input/);
  f.child.stdin.write("clear\n"); await until(() => bridge.snapshot(preferences).statuses.length === 0);
  f.child.stdin.write("oversized\n"); await until(() => bridge.snapshot(preferences).warnings.length > 0);
  assert.match(bridge.snapshot(preferences).warnings[0]!.message, /65536/);
  f.child.stdin.write("exit\n"); assert.equal((await f.closed).code, 7);
  assert.match(f.errors(), /65536/);
});
test("unconfigured preload is transparent, including native exit status", async (t) => {
  const f = await launch(t);
  await until(() => f.output().includes("long"));
  f.child.stdin.write("exit\n"); assert.equal((await f.closed).code, 7); assert.equal(f.errors(), "");
});
test("HTTP failure never corrupts stdout or prevents normal Pi traffic", async (t) => {
  const f = await launch(t, { ZEONEST_PI_STATUS_URL: "http://127.0.0.1:1/snapshot", ZEONEST_PI_STATUS_TOKEN: "test" });
  await until(() => f.errors().includes("unavailable"));
  f.child.stdin.write("still works\n"); await until(() => f.output().includes("still works"));
  f.child.stdin.write("exit\n"); assert.equal((await f.closed).code, 7);
});
test("invalidated token stops transport without stopping Pi", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.writeHead(403).end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const f = await launch(t, { ZEONEST_PI_STATUS_URL: `http://127.0.0.1:${address.port}/snapshot`, ZEONEST_PI_STATUS_TOKEN: "expired" });
  await until(() => f.errors().includes("rejected snapshot"));
  f.child.stdin.write("update\n"); await delay(650);
  assert.equal(requests, 1); assert.match(f.output(), /Updated detail/);
  f.child.stdin.write("exit\n"); assert.equal((await f.closed).code, 7);
});
test("interrupted HTTP responses cannot crash Pi or break subsequent RPC traffic", async (t) => {
  const server = createServer((req, res) => {
    req.resume(); res.writeHead(200, { "content-length": "5000" }); res.write("partial");
    setTimeout(() => res.destroy(), 15);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const f = await launch(t, { ZEONEST_PI_STATUS_URL: `http://127.0.0.1:${address.port}/snapshot`, ZEONEST_PI_STATUS_TOKEN: "test" });
  await until(() => f.errors().includes("response interrupted"));
  f.child.stdin.write("normal after interrupted response\n");
  await until(() => f.output().includes("normal after interrupted response"));
  f.child.stdin.write("exit\n"); assert.equal((await f.closed).code, 7);
});

test("SIGTERM retains native process signal semantics (no intermediary process)", async (t) => {
  const f = await launch(t); await until(() => f.output().includes("long"));
  f.child.kill("SIGTERM"); assert.deepEqual(await f.closed, { code: null, signal: "SIGTERM" });
});

test("preload preserves write receiver, overload arguments, callback identity, errors and false/backpressure return", async (t) => {
  const home = await directory(t); const path = await createPreload(home).prepare();
  const before = join(home, "before.mjs"); const main = join(home, "main.mjs");
  await writeFile(before, `globalThis.calls = []; globalThis.raw = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (...args) { if (args[0] === 'throw') throw globalThis.expectedError;
      globalThis.calls.push({ receiver: this, args }); return false; };`);
  await writeFile(main, `import assert from 'node:assert/strict';
    const receiver = {}; const callback = () => {}; const buffer = Buffer.from('x');
    assert.equal(process.stdout.write.call(receiver, buffer, callback), false);
    assert.equal(calls[0].receiver, receiver); assert.equal(calls[0].args[0], buffer); assert.equal(calls[0].args[1], callback);
    assert.equal(process.stdout.write('abc', 'latin1', callback), false);
    assert.deepEqual(calls[1].args, ['abc', 'latin1', callback]);
    globalThis.expectedError = new Error('sentinel');
    assert.throws(() => process.stdout.write('throw'), error => error === expectedError);
    raw('ok\\n');`);
  const env = observerEnvironment(path, { ZEONEST_PI_STATUS_URL: "http://127.0.0.1:1/snapshot", ZEONEST_PI_STATUS_TOKEN: "test" }, { NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(before).href)}` });
  const f = capture(t, spawn(process.execPath, [main, "--mode=rpc"], { env: { ...process.env, ...env }, stdio: "pipe" }));
  assert.equal((await f.closed).code, 0, f.errors()); assert.equal(f.output(), "ok\n");
});

test("children, nested Pi and workers inherit user options but not observer credentials or injection", async (t) => {
  const bridge = createBridge(); t.after(() => bridge.close());
  const f = await launch(t, await bridge.open("a", "w"));
  await until(() => bridge.snapshot(preferences).statuses.length === 1);
  f.child.stdin.write("nested\n"); await until(() => f.output().includes('"type":"nested"'));
  const report = JSON.parse(f.output().split("\n").find((line) => line.includes('"type":"nested"'))!);
  for (const child of [report.child, report.worker]) {
    assert.equal(child.token, false); assert.equal(child.preload, false);
    assert.equal(child.options, "--trace-warnings");
  }
  await delay(350); assert.deepEqual(bridge.snapshot(preferences).statuses.map((status) => status.key), ["lens"]);
  f.child.stdin.write("exit\n"); assert.equal((await f.closed).code, 7);
});

test("an inactive non-RPC process clears only injected environment and does not patch stdout or keep Node alive", async (t) => {
  const home = await directory(t); const path = await createPreload(home).prepare();
  const env = observerEnvironment(path, { ZEONEST_PI_STATUS_URL: "http://127.0.0.1:1/snapshot", ZEONEST_PI_STATUS_TOKEN: "test" }, {}, "--trace-warnings");
  const f = capture(t, spawn(process.execPath, ["--input-type=module", "-e", `console.log(JSON.stringify({ token: !!process.env.ZEONEST_PI_STATUS_TOKEN, options: process.env.NODE_OPTIONS, patched: process.stdout.write.toString().includes('Reflect.apply') }));`], { env: { ...process.env, ...env }, stdio: "pipe" }));
  assert.equal((await f.closed).code, 0); assert.deepEqual(JSON.parse(f.output()), { token: false, options: "--trace-warnings", patched: false });
});

test("Paseo MCP command-only probes cannot publish under the real agent's channel", async (t) => {
  const bridge = createBridge(); t.after(() => bridge.close());
  const channel = await bridge.open("a", "w");
  const probe = await launch(t, channel, { TEST_PI_PROBE: "1" });
  await until(() => probe.output().includes('"command":"get_commands"'));
  await delay(450); assert.equal(bridge.snapshot(preferences).statuses.length, 0);
  const main = await launch(t, channel);
  await until(() => bridge.snapshot(preferences).statuses.length === 1);
  probe.child.stdin.write("update\n"); await delay(450);
  assert.match(bridge.snapshot(preferences).statuses[0]!.text, /^😀分析/);
  probe.child.stdin.write("exit\n"); main.child.stdin.write("exit\n");
  await Promise.all([probe.closed, main.closed]);
});

test("active observer HTTP and heartbeat cannot keep an otherwise-finished RPC process alive", { timeout: 6000 }, async (t) => {
  const server = createServer((req) => { req.resume(); }); // Deliberately never responds.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const home = await directory(t); const path = await createPreload(home).prepare();
  const main = join(home, "finish.mjs");
  await writeFile(main, `console.log(JSON.stringify({ type: 'response', command: 'get_state', success: true })); setTimeout(() => {}, 450);`);
  const env = observerEnvironment(path, { ZEONEST_PI_STATUS_URL: `http://127.0.0.1:${address.port}/snapshot`, ZEONEST_PI_STATUS_TOKEN: "test" }, {});
  const f = capture(t, spawn(process.execPath, [main, "--mode", "rpc"], { env: { ...process.env, ...env }, stdio: "pipe" }));
  assert.equal((await f.closed).code, 0);
});

// Optional local compatibility check: no package install, model request or personal Pi state.
function localPiLaunch() {
  if (process.env.ZEONEST_TEST_PI_ENTRY) return { command: process.execPath, args: [process.env.ZEONEST_TEST_PI_ENTRY] };
  try {
    // Launch the installed command as-is, including package-manager shell shims.
    const command = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    return { command, args: [] as string[] };
  } catch { return undefined; }
}
const piLaunch = localPiLaunch();
test("real installed Pi publishes session_start status through its stdout takeover without altering RPC", { skip: piLaunch ? false : "Set ZEONEST_TEST_PI_ENTRY to an installed Pi CLI JS entry", timeout: 30000 }, async (t) => {
  const home = await directory(t); const path = await createPreload(home).prepare();
  const bridge = createBridge(); t.after(() => bridge.close());
  const env = observerEnvironment(path, await bridge.open("real", "w"), {});
  const extension = new URL("./fixtures/real-pi-extension.mjs", import.meta.url).pathname;
  const f = capture(t, spawn(piLaunch!.command, [...piLaunch!.args, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--extension", extension], {
    cwd: home, env: { ...process.env, ...env, PI_CODING_AGENT_DIR: join(home, "pi-home") }, stdio: "pipe",
  }));
  f.child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
  await until(() => bridge.snapshot(preferences).statuses.some((status) => status.key === "startup"), 20000);
  assert.equal(bridge.snapshot(preferences).statuses[0]!.text, "启动 😀\nFull startup detail");
  await until(() => f.output().includes('"id":"state"'));
  const frames = f.output().trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(frames.some((frame) => frame.method === "setStatus" && frame.statusKey === "startup"));
  assert.ok(frames.some((frame) => frame.type === "response" && frame.id === "state" && frame.success));
  f.child.stdin.write(JSON.stringify({ id: "command", type: "prompt", message: "/bridge-test-update" }) + "\n");
  await until(() => bridge.snapshot(preferences).statuses.some((status) => status.text === "Command detail"));
  f.child.stdin.write(JSON.stringify({ id: "clear", type: "prompt", message: "/bridge-test-clear" }) + "\n");
  await until(() => bridge.snapshot(preferences).statuses.length === 0);
  f.child.kill("SIGTERM"); await f.closed;
});
