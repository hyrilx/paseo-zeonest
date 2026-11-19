import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ownedIdentity } from "./managed-platform";

const recordSchema = z.object({
  format: z.literal(1), revision: z.string().min(1), port: z.number().int().min(1).max(65535),
  desired: z.enum(["running", "stopped"]), identity: ownedIdentity.optional(),
  spawnedPid: z.number().int().positive().safe().optional(), launchedAt: z.number().int().positive().optional(),
  error: z.string().max(1024).optional(),
});
export type ManagedRecord = z.infer<typeof recordSchema>;
export function managedDirectory(): string {
  return join(resolve(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo")), "zeonest", "billion-context");
}
async function readFile(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) throw new Error("托管服务记录无效，请人工检查记录文件");
    return await file.readFile("utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  finally { await file?.close(); }
}
export class ManagedStore {
  constructor(readonly directory = managedDirectory()) {}
  async read(): Promise<ManagedRecord | undefined> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("托管服务目录不能是符号链接或非目录");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const text = await readFile(join(this.directory, "service.json"));
    if (text === undefined) return undefined;
    try { return recordSchema.parse(JSON.parse(text)); }
    catch { throw new Error("托管服务记录无效；不会接管地址或自动另开实例，请检查 service.json"); }
  }
  async write(record: ManagedRecord): Promise<ManagedRecord> {
    const next = recordSchema.parse({ ...record, revision: randomUUID() });
    const path = join(this.directory, ".service-" + randomUUID());
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
    finally { await file.close(); }
    try { await rename(path, join(this.directory, "service.json")); }
    finally { await unlink(path).catch(() => {}); }
    return next;
  }
  async lock<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("托管服务目录不能是符号链接");
    const path = join(this.directory, "service.lock");
    const token = randomUUID();
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); }
        finally { await file.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A separate reaper lock serializes stale-owner checks. Unknown owners are never deleted.
        let reaper;
        try {
          reaper = await open(path + ".reaper", "wx", 0o600);
          const text = await readFile(path);
          if (text) {
            let owner: unknown;
            try { owner = JSON.parse(text); } catch { owner = undefined; }
            const parsed = z.object({ pid: z.number().int().positive().safe(), token: z.string().min(1) }).safeParse(owner);
            if (parsed.success) {
              let alive = true;
              try { process.kill(parsed.data.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
              if (!alive) await unlink(path).catch(() => {});
            }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        finally { if (reaper) { await reaper.close(); await unlink(path + ".reaper").catch(() => {}); } }
        if (Date.now() >= deadline) throw new Error("托管服务正在被其他操作占用，或锁记录需要人工检查；请稍后刷新");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try { return await run(); }
    finally {
      const text = await readFile(path);
      if (text && JSON.parse(text).token === token) await unlink(path);
    }
  }
}
