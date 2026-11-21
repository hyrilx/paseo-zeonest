import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
};

export function workspaceRoot(directory: string) {
  if (!isAbsolute(directory)) throw new Error("宿主返回的工作区目录无效");
  const path = realpathSync(directory);
  if (!lstatSync(path).isDirectory()) throw new Error("工作区目录不存在");
  return path;
}

export function resolveWithin(root: string, rel: string) {
  if (rel === ".") return root;
  if (rel.length > 1024 || /[\\:\x00-\x1f\x7f]/u.test(rel) || rel.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new Error("路径必须是工作区内的相对路径");
  }
  const parts = rel.split("/");
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("不读取符号链接：" + rel);
    } catch (e) {
      if (!missing(e)) throw e;
    }
  }
  if (!inside(root, path) || path !== resolve(root, rel)) throw new Error("路径超出工作区");
  return path;
}

export const at = (project: string, name: string) => project === "." ? name : project + "/" + name;

export function readBounded(path: string, max: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error("文件不是普通文件或超过读取上限");
    const buf = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buf.length) {
      const count = readSync(fd, buf, offset, buf.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > stat.size) throw new Error("读取期间文件发生变化，请重试");
    return buf.toString("utf8", 0, offset);
  } finally { closeSync(fd); }
}

export function readText(root: string, rel: string, max = 512 * 1024): string | undefined {
  try {
    return readBounded(resolveWithin(root, rel), max);
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}

const skipped = new Set(["node_modules", "target", "dist", "build", "vendor", "Pods", "DerivedData"]);
export function projectDirs(root: string) {
  let limited = false;
  let count = 0;
  const dirs = ["."];
  for (let i = 0; i < dirs.length && count < 4096 && dirs.length < 256; i++) {
    const rel = dirs[i]!;
    if (rel.split("/").length >= 4) { limited = true; continue; }
    try {
      const dir = opendirSync(resolveWithin(root, rel));
      try {
        for (let item; (item = dir.readSync()) !== null;) {
          if (++count > 4096 || dirs.length >= 256) { limited = true; break; }
          if (item.isDirectory() && !item.name.startsWith(".") && !skipped.has(item.name)) dirs.push(at(rel, item.name));
        }
      } finally { dir.closeSync(); }
    } catch { limited = true; }
  }
  return { dirs, limited };
}
