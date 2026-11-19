import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ManagedStore } from "../server/managed-store";
import { ManagedService } from "../server/managed-service";
import { createManagedPlatform, type LaunchedProcess } from "../server/managed-platform";
import contribute from "../server/index";
import contributeSettings from "../server/settings";
import contributeRpc from "../server/rpc";
import { preferencesSchema } from "../shared/settings";
import { resolveDashboard } from "../shared/contracts";
import { serviceControl, serviceStatus } from "../shared/managed-contracts";

test("isolated process: managed endpoint pins Pi/panels, survives plugin reload, then rotates only on confirmation", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zeonest-managed-process-"));
  const command = join(root, "fake-bili");
  await copyFile(new URL("./fixtures/fake-bili.cjs", import.meta.url), command); await chmod(command, 0o700);
  const children: LaunchedProcess[] = []; const platform = createManagedPlatform(); const spawn = platform.spawn;
  platform.spawn = async (binary, port) => { assert.equal(binary, command); const child = await spawn(binary, port); children.push(child); return child; };
  const store = new ManagedStore(join(root, "state")); let manager = new ManagedService(store, platform);
  const handlers = new Map<string, (input: any, context?: any) => any>();
  let hook!: (input: any, context: any) => Promise<any>;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: preferencesSchema.parse({ biliCommand: command, serverOrigin: "http://legacy-address.invalid:1", browserOrigin: "http://client.test:{port}" }) }) }),
    handle: (contract: { name: string }, handler: (input: any, context?: any) => any) => { handlers.set(contract.name, handler); },
    addHook: (_name: string, handler: typeof hook) => { hook = handler; return () => {}; },
  } as unknown as PluginServerContext;
  let stopSettings = contributeSettings(server, manager); let stopRpc = contributeRpc(server); let stop = contribute(server);
  t.after(async () => {
    await stop(); stopRpc(); await stopSettings(); await manager.close();
    // Only handles created from our own executable fixture are eligible for emergency test cleanup.
    for (const child of children) if (!child.exited()) child.terminate();
    for (let i = 0; i < 30 && children.some((child) => !child.exited()); i++) await platform.sleep(50);
    await rm(root, { recursive: true, force: true });
  });
  const context = { signal: new AbortController().signal };
  const request = { provider: "pi", purpose: "interactive", reason: "create", env: { KEEP: "yes" }, workspaceId: "w" };
  const transformed = await hook({ request }, context); const first = await handlers.get(serviceStatus.name)!({});
  assert.equal(first.phase, "running"); assert.equal(first.version, "test-fixture"); assert.equal(children.length, 1);
  assert.equal(transformed.env.BILI_PI_INLINE, "0"); assert.equal(transformed.env.BILLION_CONTEXT_ATTACH, first.origin);
  const paseo = {
    workspaces: { ref: () => ({ refresh: async () => ({ id: "w" }) }) },
    agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { workspaceId: "w", persistence: { sessionId: agentId + "/provider" } } }) }) },
  };
  const overview = await handlers.get(resolveDashboard.name)!({ workspaceId: "w" }, { paseo });
  assert.deepEqual(overview, { url: "http://client.test:" + first.port + "/__bili/", workspaceId: "w" });
  for (const agentId of ["one", "two"]) {
    const target = await handlers.get(resolveDashboard.name)!({ workspaceId: "w", agentId }, { paseo });
    assert.equal(target.url, "http://client.test:" + first.port + "/__bili/#/session/" + encodeURIComponent("fixture/" + agentId + "/provider"));
  }
  await assert.rejects(handlers.get(resolveDashboard.name)!({ workspaceId: "w", instanceOrigin: "http://other.invalid:1" }, { paseo }), /实例已更换/);
  await stop(); stopRpc(); await stopSettings(); assert.equal(platform.alive(first.pid), true);
  manager = new ManagedService(store, platform); stopSettings = contributeSettings(server, manager); stopRpc = contributeRpc(server); stop = contribute(server);
  await hook({ request }, context); const adopted = await handlers.get(serviceStatus.name)!({});
  assert.equal(adopted.pid, first.pid); assert.equal(adopted.origin, first.origin); assert.equal(children.length, 1);
  await assert.rejects(handlers.get(serviceControl.name)!({ action: "rotate", revision: adopted.revision }), /明确确认/);
  const rotated = await handlers.get(serviceControl.name)!({ action: "rotate", revision: adopted.revision, confirmPortChange: true });
  assert.notEqual(rotated.port, first.port); assert.notEqual(rotated.pid, first.pid); assert.equal(children.length, 2);
  assert.equal((await hook({ request }, context)).env.BILLION_CONTEXT_ATTACH, rotated.origin);
  await handlers.get(serviceControl.name)!({ action: "stop", revision: rotated.revision });
  await assert.rejects(hook({ request }, context), /手动停止/);
});
