import type { StatsSnapshot } from "./types";

export function createStatsStore() {
  let snapshot: StatsSnapshot = {
    rounds: 0, steps: 0, tools: 0, modelMs: null, toolMs: null, ttftMs: null, averageTps: null, instantTps: null,
    status: "loading", partial: false, warning: "",
  };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: StatsSnapshot) {
      if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
export type StatsStore = ReturnType<typeof createStatsStore>;
export function speed(value: number | null): string {
  return value === null ? "未采集" : `≈ ${value.toFixed(value < 100 ? 1 : 0)} tok/s`;
}
export function seconds(value: number | null): string {
  return value === null ? "未采集" : `≈ ${(value / 1000).toFixed(1)} 秒`;
}
