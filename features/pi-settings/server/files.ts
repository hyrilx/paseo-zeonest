import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createTwoFilesPatch, diffLines } from "diff";

export const MAX_TEXT = 1_048_576;
export function hash(text: string | Uint8Array): string { return createHash("sha256").update(text).digest("hex"); }
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
/** Resolve missing leaves too, without following a dangling link or leaving the authorized root. */
export function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`拒绝悬空符号链接：${path}`);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(canonical(parent), relative(parent, path));
}
export interface Target { path: string; root: string; real: string }
export function target(path: string, root: string): Target {
  const realRoot = canonical(root);
  const real = canonical(path);
  if (!inside(realRoot, real)) throw new Error(`路径的符号链接指向授权目录之外：${path}`);
  return { path: resolve(path), root: realRoot, real };
}
export function revalidate(t: Target): void {
  if (canonical(t.path) !== t.real || !inside(t.root, canonical(t.path))) throw new Error(`路径已改变，请重新读取：${t.path}`);
}
export interface FileState { target: Target; text: string | null; revision: string; mode: number }
export function readState(t: Target): FileState {
  revalidate(t);
  if (!existsSync(t.real)) return { target: t, text: null, revision: "missing", mode: 0o600 };
  const info = statSync(t.real);
  if (!info.isFile() || info.size > MAX_TEXT) throw new Error(`不是普通文本文件或超过 1 MiB：${t.path}`);
  const bytes = readFileSync(t.real);
  const text = bytes.toString("utf8");
  if (text.includes("\u0000") || !bytes.equals(Buffer.from(text, "utf8"))) throw new Error(`不是 UTF-8 文本文件：${t.path}`);
  return { target: t, text, revision: hash(bytes), mode: info.mode & 0o777 };
}
export function assertRevision(state: FileState, expected: string): void {
  if (state.revision !== expected) throw new Error(`配置已被其他客户端或进程修改，请重新读取：${state.target.path}`);
}
export function fileDiff(path: string, before: string | null, after: string | null) {
  let additions = 0; let deletions = 0;
  for (const part of diffLines(before ?? "", after ?? "")) {
    if (part.added) additions += part.count ?? 0;
    if (part.removed) deletions += part.count ?? 0;
  }
  return { path, additions, deletions, diff: createTwoFilesPatch(before === null ? "/dev/null" : path, after === null ? "/dev/null" : path, before ?? "", after ?? "", "", "", { context: 3 }) };
}
export function atomicWrite(t: Target, text: string | null, mode: number): void {
  revalidate(t);
  mkdirSync(dirname(t.real), { recursive: true, mode: 0o700 });
  if (text === null) { rmSync(t.real, { force: true }); return; }
  const temporary = join(dirname(t.real), `.zeonest-write-${randomUUID()}`);
  try { writeFileSync(temporary, text, { mode, flag: "wx" }); renameSync(temporary, t.real); }
  finally { rmSync(temporary, { force: true }); }
}
export interface TreeState { revision: string; files: Map<string, string> }
/** Hash bytes, not mtimes. Links are hashed but never traversed. Bound malicious package trees. */
export function treeState(path: string): TreeState {
  const files = new Map<string, string>();
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name); const rel = relative(path, full);
      if (files.size > 100_000) throw new Error("安装目录文件过多，拒绝暂存。");
      if (entry.isSymbolicLink()) files.set(rel, `link:${readlinkSync(full)}`);
      else if (entry.isDirectory()) { files.set(`${rel}/`, "dir"); walk(full); }
      else if (entry.isFile()) {
        const info = statSync(full); bytes += info.size;
        if (info.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024) throw new Error("安装目录超过安全暂存限制（单文件 64 MiB / 总计 512 MiB）。");
        files.set(rel, `${info.mode & 0o777}:${hash(readFileSync(full))}`);
      } else throw new Error(`安装目录包含特殊文件：${full}`);
    }
  };
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) throw new Error(`安装根必须是普通目录：${path}`);
    walk(path);
  }
  return { files, revision: existsSync(path) ? hash(JSON.stringify([...files])) : "missing" };
}
export function treeDiff(path: string, before: TreeState, after: TreeState) {
  let added = 0; let removed = 0; let changed = 0;
  for (const [key, value] of after.files) { if (!before.files.has(key)) added++; else if (before.files.get(key) !== value) changed++; }
  for (const key of before.files.keys()) if (!after.files.has(key)) removed++;
  return { path, added, removed, changed };
}
/** Reject links escaping the staged tree; packages must stay movable and self-contained. */
export function validateTreeLinks(root: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const link = readlinkSync(full);
        if (isAbsolute(link) || !inside(root, resolve(dirname(full), link))) throw new Error(`包包含不可安全移动的符号链接：${full}`);
      } else if (entry.isDirectory()) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
}
export function copyTree(from: string, to: string): void {
  if (existsSync(from)) { validateTreeLinks(from); cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true }); }
}
/** Cooperating Zeonest processes share a canonical-path lock. Never steal an unknown lock. */
export function lockTargets(paths: string[]): () => void {
  const held: string[] = [];
  const release = () => { for (const path of held.reverse()) rmSync(path, { force: true }); };
  try {
    for (const path of [...new Set(paths)].sort()) {
      const lock = join(tmpdir(), `zeonest-pi-${hash(path)}.lock`);
      const fd = openSync(lock, "wx", 0o600); closeSync(fd); held.push(lock);
    }
    return release;
  } catch { release(); throw new Error("另一个配置操作正在写入，或有未清理的锁；请稍后重试。不要覆盖其他进程的锁。"); }
}
