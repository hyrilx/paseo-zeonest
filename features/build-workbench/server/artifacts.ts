import { lstatSync, opendirSync } from "node:fs";
import type { Artifact } from "../shared/contracts";
import { at, missing, resolveWithin } from "./paths";

const LIMIT = 160;
type Observation = { stamp: string; directory?: true } | "missing" | "unavailable";
type Snapshot = { files: Map<string, Observation>; limited: boolean };

export function observe(root: string, outputs: string[]): Snapshot {
  const files = new Map<string, Observation>();
  let limited = false;
  let visited = 0;
  function visit(rel: string, depth: number, explicit: boolean) {
    if (++visited > LIMIT || depth > 8) { limited = true; return; }
    try {
      const path = resolveWithin(root, rel);
      const s = lstatSync(path, { bigint: true });
      if (!s.isFile() && !s.isDirectory()) { files.set(rel, "unavailable"); return; }
      const stamp = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
      if (s.isFile()) { files.set(rel, { stamp }); return; }
      if (explicit) files.set(rel, { stamp, directory: true });
      const dir = opendirSync(path);
      try {
        for (let item; visited <= LIMIT && (item = dir.readSync()) !== null;) {
          if (item.isFile() || item.isDirectory() || item.isSymbolicLink()) visit(at(rel, item.name), depth + 1, false);
          else if (++visited > LIMIT) limited = true;
        }
      } finally { dir.closeSync(); }
    } catch (e) { files.set(rel, missing(e) ? "missing" : "unavailable"); }
  }
  for (const rel of outputs) visit(rel, 0, true);
  return { files, limited };
}

export function changes(before: Snapshot, after: Snapshot) {
  const artifacts: Artifact[] = [];
  for (const path of new Set([...after.files.keys(), ...before.files.keys()])) {
    const prev = before.files.get(path);
    const next = after.files.get(path);
    if (!next && after.limited) continue;
    const state = next === "unavailable" || (!prev && before.limited)
      ? "unavailable" : !next || next === "missing"
        ? prev && typeof prev === "object" ? "removed" : "missing"
        : !prev || prev === "missing" ? "new"
          : prev === "unavailable" ? "unavailable" : next.stamp === prev.stamp ? "existing" : "changed";
    artifacts.push({ path, state });
  }
  return { artifacts, artifactsLimited: before.limited || after.limited };
}
