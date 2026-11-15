import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { preloadSource } from "./preload-source";

// Content-addressed and retained across reloads: already-starting processes may still import it.
export function createPreload(home = homedir()) {
  const parent = join(home, ".zeonest");
  const directory = join(parent, "pi-status-bridge");
  const hash = createHash("sha256").update(preloadSource).digest("hex").slice(0, 16);
  const path = join(directory, `observer-${hash}.mjs`);
  async function safeDirectory(target: string) {
    await mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`观察器目录不是普通目录：${target}`);
  }
  async function prepare() {
    await safeDirectory(parent); await safeDirectory(directory);
    // Publish a complete file atomically, including concurrent first session opens.
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, preloadSource, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    } finally { await unlink(temporary).catch(() => {}); }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("拒绝读取非普通观察器文件");
    if (await readFile(path, "utf8") !== preloadSource) throw new Error("观察器内容已改变；请先手动检查，不会自动覆盖");
    // Node resolves ESM imports through symlinked ancestors (e.g. macOS /var).
    return realpath(path);
  }
  return { prepare };
}

export function observerEnvironment(path: string, channel: Record<string, string>, env: Record<string, string>, fallback = process.env.NODE_OPTIONS): Record<string, string> & { NODE_OPTIONS: string } {
  let base: string | null = env.NODE_OPTIONS ?? fallback ?? null;
  const previous = env.ZEONEST_PI_STATUS_PRELOAD;
  if (previous && env.NODE_OPTIONS?.endsWith(` --import=${JSON.stringify(previous)}`)) {
    try {
      const original: unknown = JSON.parse(env.ZEONEST_PI_STATUS_BASE_NODE_OPTIONS!);
      if (original !== null && typeof original !== "string") throw new Error("invalid marker");
      base = original;
    } catch { throw new Error("无效的观察器环境标记"); }
  }
  const url = pathToFileURL(path).href;
  return { ...env, ...channel,
    NODE_OPTIONS: `${base ?? ""} --import=${JSON.stringify(url)}`,
    ZEONEST_PI_STATUS_PRELOAD: url,
    ZEONEST_PI_STATUS_BASE_NODE_OPTIONS: JSON.stringify(base),
  };
}

// config.get() exposes provider overrides at config.providers, not persisted agents.providers.
export function providerNodeOptions(env: unknown): string | undefined {
  if (!env || typeof env !== "object" || !("NODE_OPTIONS" in env)) return undefined;
  const value = env.NODE_OPTIONS;
  if (typeof value !== "string") throw new Error("Pi provider 的 NODE_OPTIONS 不是字符串");
  return value;
}
