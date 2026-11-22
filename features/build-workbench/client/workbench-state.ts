import { live, targetId } from "../shared/contracts";
import type { Candidate, Run, Target } from "../shared/contracts";

export function defaultTool(candidates: Candidate[], saved?: string) {
  return saved ?? (candidates.find((item) => item.gradleRuntime?.status === "compatible") ??
    candidates.find((item) => item.gradleRuntime?.status !== "incompatible"))?.id ?? "";
}

// Track these within one mounted workspace. Historical successes are not new events.
export class ProbeCompletions {
  #pending = new Set<string>();

  watch(run: Run) { if (run.operation === "probe") this.#pending.add(run.id); }

  observe(runs: Run[]) {
    const successful: Run[] = [];
    for (const run of runs) {
      if (live(run.status)) this.watch(run);
      else if (this.#pending.delete(run.id) && run.status === "success") successful.push(run);
    }
    return successful;
  }
}

export function addedTargets(before: Target[], after: Target[], probes: Run[]) {
  const oldIds = new Set(before.map(targetId));
  return after.filter((target) => !oldIds.has(targetId(target)) && !target.operation && probes.some(({ configuration: { target: from } }) =>
    from.adapter === target.adapter && from.project === target.project)).map(targetId);
}

export const limitDock = (height: number, min: number, max: number) => Math.max(min, Math.min(max, height));
