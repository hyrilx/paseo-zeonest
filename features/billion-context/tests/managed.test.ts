import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ManagedService } from "../server/managed-service";
import { ManagedStore, managedDirectory } from "../server/managed-store";
import { launcherEnvironment, type ManagedPlatform, type OwnedIdentity } from "../server/managed-platform";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "zeonest-managed-"));
  const ports = new Map<number, OwnedIdentity>(); const running = new Set<number>();
  const launches: { command: string; port: number }[] = []; const signals: number[] = [];
  let now = Date.now(), nextPort = 41000, nextPid = 1000;
  const state = { failSpawn: false, failProbe: false, neverReady: false, keepAliveOnStop: false, occupied: new Set<number>() };
  const platform: ManagedPlatform = {
    now: () => now, sleep: async (ms) => { now += ms; }, alive: (pid) => running.has(pid),
    allocate: async () => nextPort++, available: async (port) => !ports.has(port) && !state.occupied.has(port),
    probe: async (origin) => state.failProbe ? undefined : ports.get(Number(new URL(origin).port)),
    spawn: async (command, port) => {
      launches.push({ command, port });
      if (state.failSpawn) throw new Error("test launch failure");
      const pid = nextPid++; const identity = { pid, instanceId: "owned-" + pid, startedAt: now, version: "0.1.215" };
      running.add(pid); if (!state.neverReady) ports.set(port, identity);
      return { pid, exited: () => !running.has(pid), terminate: () => { running.delete(pid); if (ports.get(port)?.pid === pid) ports.delete(port); } };
    },
    signal: (pid) => { signals.push(pid); if (state.keepAliveOnStop) return; running.delete(pid); for (const [port, identity] of ports) if (identity.pid === pid) ports.delete(port); },
  };
  const store = new ManagedStore(directory); const manager = new ManagedService(store, platform);
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, ports, running, launches, signals, state, platform, store, manager };
}
test("managed launcher allocates once, persists identity, and shares concurrent readiness", async (t) => {
  const f = await fixture(t); assert.equal((await f.manager.status()).phase, "unconfigured");
  const ready = f.manager.enable("/bin/fake-bili"); const second = f.manager.ensure("/bin/fake-bili");
  await Promise.all([ready, second]);
  assert.deepEqual(f.launches, [{ command: "/bin/fake-bili", port: 41000 }]);
  const status = await f.manager.status(); assert.equal(status.phase, "running"); assert.equal(status.pid, 1000); assert.equal(status.version, "0.1.215");
  const record = await f.store.read(); assert.equal(record?.identity?.pid, status.pid);
  assert.equal((await stat(join(f.directory, "service.json"))).mode & 0o777, 0o600);
});
test("service survives disable/reload; a new controller adopts only the persisted identity", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); await f.manager.disable();
  assert.equal((await f.manager.status()).enabled, false); assert.equal((await f.manager.status()).phase, "running"); assert.deepEqual(f.signals, []);
  const next = new ManagedService(f.store, f.platform); t.after(() => next.close());
  await next.enable("other-path"); assert.equal(f.launches.length, 1); assert.equal((await next.status()).pid, 1000);
});
test("two controllers serialize on the host record and do not create two processes", async (t) => {
  const f = await fixture(t); const next = new ManagedService(f.store, f.platform); t.after(() => next.close());
  await Promise.all([f.manager.enable("fake"), next.enable("fake")]); assert.equal(f.launches.length, 1);
});
test("crash recovery keeps the existing port and records a new process identity", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); const old = await f.manager.status();
  f.ports.clear(); f.running.clear(); const ready = await f.manager.ensure("new-path");
  assert.equal(ready.origin, old.origin); assert.notEqual(ready.pid, old.pid); assert.equal(f.launches[1]?.command, "new-path");
});
test("explicit stop persists intent across reload and requires explicit start", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake");
  const stopped = await f.manager.control("stop", (await f.manager.status()).revision, "fake");
  assert.equal(stopped.phase, "stopped"); await assert.rejects(f.manager.ensure("fake"), /手动停止/);
  await f.manager.disable(); await assert.rejects(f.manager.enable("fake"), /手动停止/); assert.equal(f.launches.length, 1);
  const ready = await f.manager.control("start", stopped.revision, "fake"); assert.equal(ready.phase, "running"); assert.equal(ready.port, stopped.port);
});
test("restart keeps port; forced rotation requires confirmation and changes port", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); const first = await f.manager.status();
  const restarted = await f.manager.control("restart", first.revision, "fake"); assert.equal(restarted.port, first.port); assert.notEqual(restarted.pid, first.pid);
  await assert.rejects(f.manager.control("rotate", restarted.revision, "fake"), /明确确认/); assert.equal(f.signals.length, 1);
  const rotated = await f.manager.control("rotate", restarted.revision, "fake", true); assert.notEqual(rotated.port, first.port); assert.equal(rotated.phase, "running");
});
test("stale revisions and disabled controls cannot stop or replace a newer instance", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); const old = await f.manager.status();
  await f.manager.control("restart", old.revision, "fake");
  await assert.rejects(f.manager.control("stop", old.revision, "fake"), /已改变/); assert.equal(f.signals.length, 1);
  await f.manager.disable();
  for (const action of ["start", "restart", "rotate"] as const) await assert.rejects(f.manager.control(action, (await f.manager.status()).revision, "fake", true), /先启用/);
  await f.manager.control("stop", (await f.manager.status()).revision, "fake"); assert.equal(f.signals.length, 2);
});
test("foreign identity on a reused port is not adopted or killed", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake");
  f.ports.set(41000, { pid: 9000, instanceId: "foreign", startedAt: Date.now(), version: "other" });
  assert.equal((await f.manager.status()).phase, "conflict");
  await assert.rejects(f.manager.ensure("fake"), /其他实例/);
  await assert.rejects(f.manager.control("rotate", (await f.manager.status()).revision, "fake", true), /拒绝终止/);
  assert.equal(f.launches.length, 1); assert.deepEqual(f.signals, []);
});
test("alive but unverified process is never replaced or killed by PID alone", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); f.state.failProbe = true;
  await assert.rejects(f.manager.ensure("fake"), /拒绝重复启动/);
  await assert.rejects(f.manager.control("stop", (await f.manager.status()).revision, "fake"), /仅按 PID/);
  assert.deepEqual(f.signals, []); assert.equal(f.launches.length, 1);
});
test("occupied stable port does not cause a silent port change", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); f.ports.clear(); f.running.clear(); f.state.occupied.add(41000);
  await assert.rejects(f.manager.ensure("fake"), /不会静默换端口/); assert.equal((await f.store.read())?.port, 41000); assert.equal(f.launches.length, 1);
});
test("initial bind race retries only before a stable instance has been established", async (t) => {
  const f = await fixture(t); f.state.occupied.add(41000); await f.manager.enable("fake");
  assert.equal((await f.manager.status()).port, 41001); assert.equal(f.launches.length, 1);
});
test("missing CLI and readiness timeout are visible and never succeed with inline fallback", async (t) => {
  const f = await fixture(t); f.state.failSpawn = true; await assert.rejects(f.manager.enable("missing"), /launch failure/);
  assert.match((await f.manager.status()).error!, /launch failure/); assert.equal((await f.manager.status()).phase, "error");
  f.state.failSpawn = false; f.state.neverReady = true;
  await assert.rejects(f.manager.ensure("fake"), /10 秒/); assert.equal(f.running.size, 0); assert.equal((await f.store.read())?.port, 41000);
});
test("graceful stop timeout does not escalate to SIGKILL or allocate another port", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); f.state.keepAliveOnStop = true;
  await assert.rejects(f.manager.control("rotate", (await f.manager.status()).revision, "fake", true), /未发送 SIGKILL/);
  assert.equal(f.launches.length, 1); assert.equal((await f.store.read())?.port, 41000);
});
test("corrupt or oversized ownership record is rejected, never overwritten", async (t) => {
  const f = await fixture(t); const path = join(f.directory, "service.json");
  await writeFile(path, "not-json"); await assert.rejects(f.manager.enable("fake"), /记录无效/); assert.equal(await readFile(path, "utf8"), "not-json");
  await writeFile(path, "x".repeat(16385)); await assert.rejects(f.manager.status(), /记录无效/); assert.equal(f.launches.length, 0);
});
test("symlink record and symlink directory are rejected", async (t) => {
  const f = await fixture(t); await writeFile(join(f.directory, "foreign"), "{}"); await symlink(join(f.directory, "foreign"), join(f.directory, "service.json"));
  await assert.rejects(f.manager.enable("fake")); assert.equal(f.launches.length, 0);
  const linked = f.directory + "-link"; await symlink(f.directory, linked); t.after(() => rm(linked));
  const manager = new ManagedService(new ManagedStore(linked), f.platform); t.after(() => manager.close());
  await assert.rejects(manager.status(), /符号链接/); await assert.rejects(manager.enable("fake"), /符号链接/);
});
test("dead lock owners are reclaimed without executing service management commands", async (t) => {
  const f = await fixture(t); await writeFile(join(f.directory, "service.lock"), JSON.stringify({ pid: 2147483647, token: "dead-owner" }));
  await f.manager.enable("fake"); assert.equal(f.launches.length, 1);
});
test("independent launch env keeps config but clears launcher ownership and pins port/update policy", () => {
  const source = { PATH: "/test", KEEP: "yes", BILI_PARENT_PID: "77", BILI_LAUNCH_TOKEN: "private", BILI_LAUNCHER_LANE: "pi", ACP_AUTO_RESTART_ON_UPDATE: "1" };
  const env = launcherEnvironment(source); assert.equal(env.PATH, "/test"); assert.equal(env.KEEP, "yes");
  assert.equal(env.BILI_PARENT_PID, undefined); assert.equal(env.BILI_LAUNCH_TOKEN, undefined); assert.equal(env.BILI_LAUNCHER_LANE, undefined);
  assert.equal(env.BILI_STRICT_PORT, "1"); assert.equal(env.ACP_AUTO_UPDATE, "0"); assert.equal(env.ACP_AUTO_RESTART_ON_UPDATE, "0"); assert.equal(source.BILI_PARENT_PID, "77");
});
test("service record is scoped to the daemon home, not the working directory", () => {
  const previous = process.env.PASEO_HOME;
  try { process.env.PASEO_HOME = "/test/daemon-one"; assert.equal(managedDirectory(), "/test/daemon-one/zeonest/billion-context"); }
  finally { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; }
});
test("confirmed rotation leaves an unrelated port owner alone when the recorded process is dead", async (t) => {
  const f = await fixture(t); await f.manager.enable("fake"); f.running.clear();
  const foreign = { pid: 9000, instanceId: "foreign", startedAt: Date.now(), version: "other" };
  f.ports.set(41000, foreign); f.running.add(foreign.pid);
  const result = await f.manager.control("rotate", (await f.manager.status()).revision, "fake", true);
  assert.equal(result.port, 41001); assert.equal(f.ports.get(41000), foreign); assert.deepEqual(f.signals, []);
});
