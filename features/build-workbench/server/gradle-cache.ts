import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config, PROBE_TARGET_LIMIT } from "../shared/contracts";
import { digest, readBounded } from "./paths";

const MAX_SCOPES = 16;
const MAX_EPHEMERAL_PROJECTS = 32;
const MAX_BYTES = 4 * 1024 * 1024;
const hash = z.string().regex(/^[\da-f]{64}$/u);
const result = z.object({
  stamp: hash, context: hash, tool: hash,
  filter: z.string().regex(/^[:\w.-]{1,192}$/u).optional(), options: config.shape.options,
  names: z.array(z.string().min(1).max(192)).max(PROBE_TARGET_LIMIT), limited: z.boolean(),
});
const document = z.object({ version: z.literal(1), results: z.array(result).max(MAX_SCOPES) });
type Result = z.infer<typeof result>;
export type GradleScope = { directory: string; stamp: string; volatileOwner?: string };
export type NativeResult = {
  context: string; filter?: string; options?: string[]; names: string[]; limited?: boolean;
  consume?: { id: string; take: () => void };
};

export class GradleCache {
  readonly #volatile = new Map<string, { id: string; value: Result }[]>();

  constructor(private readonly directory: string) {}

  #file(project: string) { return join(this.directory, `${digest(project)}.json`); }
  #key(scope: GradleScope) { return JSON.stringify([scope.directory, scope.volatileOwner]); }
  #read(project: string) {
    try { return document.parse(JSON.parse(readBounded(this.#file(project), MAX_BYTES))).results; }
    catch { return []; } // Missing, obsolete or damaged cache never blocks discovery.
  }

  read(scope: GradleScope, tools: ReadonlySet<string>): NativeResult[] {
    const valid = ({ stamp, tool }: Result) => stamp === scope.stamp && tools.has(tool);
    if (scope.volatileOwner === undefined) return this.#read(scope.directory).filter(valid);
    const key = this.#key(scope);
    return (this.#volatile.get(key) ?? []).filter(({ value }) => valid(value)).map(({ id, value }) => ({ ...value,
      consume: { id, take: () => {
        const remaining = this.#volatile.get(key)?.filter((item) => item.id !== id);
        if (remaining?.length) this.#volatile.set(key, remaining);
        else this.#volatile.delete(key);
      } },
    }));
  }

  publish(scope: GradleScope, found: Omit<Result, "stamp">) {
    const value = result.parse({ ...found, stamp: scope.stamp });
    const other = (old: Result) => old.stamp === scope.stamp && (old.context !== value.context || old.filter !== value.filter);
    if (scope.volatileOwner !== undefined) {
      const key = this.#key(scope);
      const previous = this.#volatile.get(key) ?? [];
      this.#volatile.delete(key);
      if (this.#volatile.size >= MAX_EPHEMERAL_PROJECTS) {
        const oldest = this.#volatile.keys().next();
        if (!oldest.done) this.#volatile.delete(oldest.value);
      }
      this.#volatile.set(key, [{ id: randomUUID(), value }, ...previous.filter(({ value }) => other(value))].slice(0, MAX_SCOPES));
      return;
    }
    const file = this.#file(scope.directory);
    const results = [value, ...this.#read(scope.directory).filter(other)].slice(0, MAX_SCOPES);
    let json = JSON.stringify({ version: 1, results });
    while (Buffer.byteLength(json) > MAX_BYTES && results.length > 1) {
      results.pop();
      json = JSON.stringify({ version: 1, results });
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, json, { flag: "wx", mode: 0o600 });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
  }
}
