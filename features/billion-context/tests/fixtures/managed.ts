import type { ServiceManager } from "../../server/managed-service";
import type { ServiceStatus } from "../../shared/managed-contracts";

export function fakeManager() {
  const calls: string[] = [];
  let failure: Error | undefined;
  const status: ServiceStatus = { enabled: false, busy: false, revision: "r1", phase: "running", origin: "http://127.0.0.1:42001", port: 42001, pid: 1000, instanceId: "owned", startedAt: 1700000000000, version: "test" };
  const manager: ServiceManager = {
    async enable(command) { calls.push("enable:" + await command); status.enabled = true; if (failure) throw failure; },
    async disable() { calls.push("disable"); status.enabled = false; }, async close() { calls.push("close"); status.enabled = false; },
    async ensure(command) {
      calls.push("ensure:" + command); if (failure) throw failure;
      return { origin: status.origin!, pid: status.pid!, instanceId: status.instanceId!, startedAt: status.startedAt!, version: status.version! };
    },
    async status() { return { ...status }; },
    async control(action) { calls.push(action); return { ...status }; },
  };
  return { manager, calls, status, fail(error?: Error) { failure = error; } };
}
