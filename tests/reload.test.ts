import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { execCommand, spawnProcess } from "@getpaseo/plugin/server";
import { createPluginReloader } from "../shell/server/reload";

function fixture(options: { env?: NodeJS.ProcessEnv; status?: unknown; execError?: Error } = {}) {
  const executions: { command: string; args: string[]; options: any }[] = [];
  const launches: { command: string; args: string[]; options: any; child: ChildProcess }[] = [];
  let kills = 0;
  const reloader = createPluginReloader({
    env: options.env ?? { PASEO_HOME: "/test/current home", PASEO_HOST: "remote:9999" },
    parentPid: 42,
    exec: (async (command, args, opts) => {
      executions.push({ command, args, options: opts });
      if (options.execError) throw options.execError;
      return { stdout: JSON.stringify(options.status ?? { workerPid: 42 }), stderr: "" };
    }) as typeof execCommand,
    spawn: ((command: string, args: string[], opts: any) => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new PassThrough(), kill: () => { kills++; return true; }, unref() {},
      }) as unknown as ChildProcess;
      launches.push({ command, args, options: opts, child });
      return child;
    }) as typeof spawnProcess,
  });
  return { reloader, executions, launches, kills: () => kills };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("reload pins the current home and plugin, verifies the worker and deduplicates clients", async () => {
  const f = fixture();
  const first = f.reloader.reload();
  assert.equal(f.reloader.reload(), first);
  await turn();
  assert.deepEqual(f.executions[0]!.args, ["daemon", "status", "--home", path.resolve("/test/current home"), "--json"]);
  const launch = f.launches[0]!;
  assert.equal(launch.command, "paseo");
  assert.deepEqual(launch.args, ["plugin", "reload", "zeonest", "--home", path.resolve("/test/current home"), "--json"]);
  assert.equal(launch.options.env.PASEO_HOST, undefined);
  assert.equal(launch.options.detached, true);
  assert.deepEqual(launch.options.stdio, ["ignore", "ignore", "pipe"]);
  launch.child.emit("close", 0, null);
  assert.deepEqual(await first, { error: null });
  f.reloader.dispose();
});

test("missing, stale and mismatched worker identity never launch a mutating CLI", async () => {
  for (const status of [{}, { pid: 42 }, { workerPid: 123 }, { workerPid: "42" }, []]) {
    const f = fixture({ status });
    assert.match((await f.reloader.reload()).error!, /无法确认 CLI 指向当前插件宿主/);
    assert.equal(f.launches.length, 0);
    f.reloader.dispose();
  }
});

test("CLI preflight errors are visible and default/tilde homes resolve locally", async () => {
  for (const env of [{}, { PASEO_HOME: "~/.custom paseo" }]) {
    const f = fixture({ env, execError: new Error("spawn paseo ENOENT") });
    assert.match((await f.reloader.reload()).error!, /ENOENT/);
    assert.equal(f.executions[0]!.options.env.PASEO_HOME,
      path.join(homedir(), "PASEO_HOME" in env ? ".custom paseo" : ".paseo"));
    assert.equal(f.launches.length, 0);
    f.reloader.dispose();
  }
});

test("CLI failures include bounded stderr and release the single-flight lock for retry", async () => {
  const f = fixture();
  const first = f.reloader.reload();
  await turn();
  f.launches[0]!.child.stderr!.emit("data", Buffer.from("x".repeat(5000) + "reload rejected"));
  f.launches[0]!.child.emit("close", 1, null);
  const failure = await first;
  assert.equal(failure.error!.length, 4096);
  assert.match(failure.error!, /reload rejected$/);
  const retry = f.reloader.reload();
  assert.notEqual(retry, first);
  await turn();
  f.launches[1]!.child.emit("error", new Error("spawn failed"));
  assert.deepEqual(await retry, { error: "spawn failed" });
  f.reloader.dispose();
});

test("cleanup cancels pending preflight and prevents delayed commands", async () => {
  let complete!: (value: { stdout: string; stderr: string }) => void;
  let spawned = false;
  const reloader = createPluginReloader({
    parentPid: 42, env: {},
    exec: (() => new Promise((resolve) => { complete = resolve; })) as typeof execCommand,
    spawn: (() => { spawned = true; throw new Error("unexpected spawn"); }) as typeof spawnProcess,
  });
  const pending = reloader.reload();
  reloader.dispose();
  complete({ stdout: '{"workerPid":42}', stderr: "" });
  assert.match((await pending).error!, /取消重载/);
  assert.equal(spawned, false);
  assert.match((await reloader.reload()).error!, /插件正在停止/);
});

test("cleanup never kills or awaits the command that is reloading this plugin", async () => {
  const f = fixture();
  const pending = f.reloader.reload();
  await turn();
  f.reloader.dispose();
  assert.equal(f.kills(), 0);
  f.launches[0]!.child.emit("close", 0, null);
  assert.deepEqual(await pending, { error: null });
});

test("a stuck CLI is bounded and reports an unconfirmed result rather than success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const pending = f.reloader.reload();
  await turn();
  t.mock.timers.tick(60_000);
  assert.match((await pending).error!, /结果尚未确认/);
  assert.equal(f.kills(), 1);
  f.reloader.dispose();
});
