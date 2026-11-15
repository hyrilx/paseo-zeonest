import type { BridgeSnapshot } from "../shared/contracts";

export interface DisplayEntry {
  id: string; agentId: string; workspaceId: string; key: string; text: string;
  command: string | null; warning: boolean;
}
export function statusId(agentId: string, key: string, warning = false) { return JSON.stringify([agentId, key, warning]); }
export function createStatusStore() {
  let entries: readonly DisplayEntry[] = [];
  const listeners = new Set<() => void>();
  function replace(next: readonly DisplayEntry[]) { entries = next; for (const listener of listeners) listener(); }
  return {
    get: () => entries,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    apply(snapshot: BridgeSnapshot) {
      replace([
        ...snapshot.statuses.map((status) => ({ ...status, id: statusId(status.agentId, status.key), warning: false })),
        ...snapshot.warnings.map((warning) => ({ ...warning, key: "状态桥接", text: warning.message,
          id: statusId(warning.agentId, "bridge-warning", true), command: null, warning: true })),
      ]);
    },
    fail(message: string) {
      const agents = new Map(entries.map((entry) => [entry.agentId, entry.workspaceId]));
      replace([...agents].map(([agentId, workspaceId]) => ({ agentId, workspaceId, key: "状态桥接",
        id: statusId(agentId, "bridge-warning", true), text: message, command: null, warning: true })));
    },
    clear() { replace([]); },
  };
}
export type StatusStore = ReturnType<typeof createStatusStore>;
