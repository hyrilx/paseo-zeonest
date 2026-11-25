import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  MAX_PROMPTS,
  promptRecordSchema,
  type DeletePromptInput,
  type DeletePromptResult,
  type PromptRecord,
  type SavePromptInput,
  type SavePromptResult,
} from "../shared/contracts";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 16 * 1024 * 1024; // 16 MiB defensive upper bound
const storeFileSchema = z.object({
  version: z.literal(STORE_VERSION),
  prompts: z.array(promptRecordSchema).max(MAX_PROMPTS),
});

type Guard = () => void;

// Serialize writes per file path across feature re-enablements in the same daemon process.
const writes = new Map<string, Promise<unknown>>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function promptStoreDirectory(): string {
  let home = process.env.PASEO_HOME ?? "~/.paseo";
  if (home === "~") home = homedir();
  else if (home.startsWith("~/")) home = join(homedir(), home.slice(2));
  return join(resolve(home), "zeonest", "prompt-manager");
}

function sortPrompts(prompts: readonly PromptRecord[]): PromptRecord[] {
  return [...prompts].sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name));
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export class PromptStore {
  readonly filePath: string;

  constructor(readonly directory = promptStoreDirectory()) {
    this.filePath = join(this.directory, "prompts.json");
  }

  private async verifyDirectory(): Promise<boolean> {
    try {
      const stat = await lstat(this.directory);
      if (!stat.isDirectory()) throw new Error("Prompt 存储目录无效");
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async readAllUnlocked(guard: Guard): Promise<PromptRecord[]> {
    guard();
    if (!(await this.verifyDirectory())) return [];
    guard();
    let file;
    try {
      file = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("Prompt 存储文件无效");
      const parsed = storeFileSchema.parse(JSON.parse(await file.readFile("utf8")));
      guard();
      return sortPrompts(parsed.prompts);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    } finally {
      await file?.close();
    }
  }

  private async writeAllUnlocked(prompts: readonly PromptRecord[], guard: Guard): Promise<void> {
    guard();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await this.verifyDirectory())) throw new Error("Prompt 存储目录不可用");
    guard();
    const payload = JSON.stringify({ version: STORE_VERSION, prompts: sortPrompts(prompts) }, null, 2);
    if (Buffer.byteLength(payload, "utf8") > MAX_STORE_BYTES) {
      throw new Error("Prompt 数据超过存储大小上限");
    }
    const temporary = join(this.directory, `.prompts-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(payload, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      guard();
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    guard();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = writes.get(this.filePath) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(task);
    writes.set(this.filePath, job);
    const cleanup = () => {
      if (writes.get(this.filePath) === job) writes.delete(this.filePath);
    };
    void job.then(cleanup, cleanup);
    return job;
  }

  async list(guard: Guard): Promise<PromptRecord[]> {
    return this.readAllUnlocked(guard);
  }

  save(input: SavePromptInput, guard: Guard): Promise<SavePromptResult> {
    guard();
    return this.enqueue(async () => {
      const current = await this.readAllUnlocked(guard);
      const now = Date.now();
      const targetId = input.id?.trim() || randomUUID();
      const existingIndex = current.findIndex((item) => item.id === targetId);
      const existing = existingIndex >= 0 ? current[existingIndex]! : null;
      const expectedRevision = input.expectedRevision ?? null;

      if (existing) {
        if (expectedRevision !== existing.revision) {
          return { status: "conflict", current: existing };
        }
      } else {
        if (expectedRevision !== null) {
          return { status: "conflict", current: null };
        }
        if (current.length >= MAX_PROMPTS) {
          throw new Error(`最多保存 ${MAX_PROMPTS} 个 Prompt`);
        }
      }

      const saved = promptRecordSchema.parse({
        id: targetId,
        revision: randomUUID(),
        name: input.name,
        description: input.description ?? "",
        tags: dedupeTags(input.tags ?? []),
        template: input.template ?? "",
        placeholders: input.placeholders ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: Math.max(now, existing?.updatedAt ?? 0),
      });

      const next = [...current];
      if (existingIndex >= 0) next[existingIndex] = saved;
      else next.push(saved);

      await this.writeAllUnlocked(next, guard);
      return { status: "saved", prompt: saved };
    });
  }

  remove(input: DeletePromptInput, guard: Guard): Promise<DeletePromptResult> {
    guard();
    return this.enqueue(async () => {
      const current = await this.readAllUnlocked(guard);
      const existingIndex = current.findIndex((item) => item.id === input.id);
      if (existingIndex < 0) {
        return { status: "not-found", id: input.id };
      }
      const existing = current[existingIndex]!;
      if (input.expectedRevision !== undefined && input.expectedRevision !== null && existing.revision !== input.expectedRevision) {
        return { status: "conflict", current: existing };
      }
      const next = current.filter((_, index) => index !== existingIndex);
      await this.writeAllUnlocked(next, guard);
      return { status: "deleted", id: input.id };
    });
  }
}
