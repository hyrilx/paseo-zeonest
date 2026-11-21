import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { satisfies, valid, validRange } from "semver";
import { parse as yaml } from "yaml";
import { digest, inside, missing, readBounded, resolveWithin } from "./paths";
import { object, TAURI_CLI_PACKAGE } from "./projects";

export type TauriCliRequest = { root: string; owner: string; install: string; manager: "npm" | "pnpm"; spec: string };
export type ResolvedTauriCli = { path: string; version: string; stamp: string };

function readDocument(path: string, parse: (text: string) => unknown = JSON.parse) {
  try { return object(parse(readBounded(realpathSync(path), 8 * 1024 * 1024))); }
  catch (error) { if (!missing(error)) throw error; }
}

function matchesFile(request: TauriCliRequest, owner: string, install: string, manifest: string, pkg: string, version: string) {
  const tarball = resolve(owner, request.spec.slice(5));
  if (!inside(request.root, tarball) || !/\.(?:tgz|tar\.gz)$/u.test(tarball)) return false;
  if (request.manager === "npm") {
    const lock = readDocument(join(install, "npm-shrinkwrap.json")) ?? readDocument(join(install, "package-lock.json"));
    const entry = object(object(lock?.packages)[relative(install, dirname(manifest))]);
    return entry.version === version && typeof entry.resolved === "string" && entry.resolved.startsWith("file:") &&
      resolve(install, entry.resolved.slice(5)) === tarball;
  }
  const lock = readDocument(join(install, "pnpm-lock.yaml"), (text) => yaml(text, { maxAliasCount: 0 }));
  const importer = object(object(lock?.importers)[relative(install, owner) || "."]);
  const entry = object(object(importer.dependencies)[TAURI_CLI_PACKAGE] ?? object(importer.devDependencies)[TAURI_CLI_PACKAGE] ??
    object(importer.optionalDependencies)[TAURI_CLI_PACKAGE]);
  const ref = entry.version;
  if (entry.specifier !== request.spec || typeof ref !== "string" || !ref.startsWith("file:") || resolve(install, ref.slice(5)) !== tarball) return false;
  const key = `${TAURI_CLI_PACKAGE}@${ref}`;
  const locked = object(object(lock?.packages)[key]);
  // Only accept the standard virtual-store link for a local tarball; version alone
  // cannot distinguish two local archives that declare the same version.
  return locked.version === version && pkg === join(install, "node_modules/.pnpm", key.replace(/\//gu, "+").replace(/:/gu, "+"), "node_modules", TAURI_CLI_PACKAGE);
}

// Resolve from the declaring package up to its install root, just like a local
// node_modules lookup. Never search executables on PATH or past that root.
export function resolveTauriCli(request: TauriCliRequest): ResolvedTauriCli | undefined {
  const { root, spec } = request;
  const owner = resolveWithin(root, request.owner);
  const install = resolveWithin(root, request.install);
  if (!inside(install, owner)) throw new Error("Tauri CLI 的声明不在所选安装根内");
  const range = validRange(spec);
  if (!range && !spec.startsWith("file:")) throw new Error("暂无法核对 Tauri CLI 依赖声明；支持版本范围和可核对的项目内 tarball");
  for (let parent = owner;; parent = dirname(parent)) {
    const manifest = join(parent, "node_modules", TAURI_CLI_PACKAGE, "package.json");
    let pkg: string;
    try { pkg = realpathSync(dirname(manifest)); }
    catch (error) {
      if (!missing(error)) throw error;
      if (parent === install) break;
      continue;
    }
    if (!inside(install, pkg)) throw new Error("项目安装的 Tauri CLI 指向安装根外；不会运行该命令");
    let source: string;
    try { source = readBounded(join(pkg, "package.json"), 512 * 1024); }
    catch (error) { if (missing(error)) return; throw error; }
    let data: Record<string, unknown>;
    try { data = object(JSON.parse(source)); }
    catch (error) { throw new Error("安装的 Tauri CLI package.json 无效", { cause: error }); }
    const version = typeof data.version === "string" ? valid(data.version) : null;
    if (data.name !== TAURI_CLI_PACKAGE || !version || !(range ? satisfies(version, range) : matchesFile(request, owner, install, manifest, pkg, version))) return;
    const bin = typeof data.bin === "string" ? data.bin : object(data.bin).tauri;
    if (typeof bin !== "string" || !bin || isAbsolute(bin)) return;
    let path: string;
    try { path = realpathSync(resolve(pkg, bin)); }
    catch (error) { if (missing(error)) return; throw error; }
    if (!inside(pkg, path) || !lstatSync(path).isFile() || !/\.[cm]?js$/u.test(path)) throw new Error("无法确认项目安装的 Tauri CLI 是包内 Node 入口");
    return { path, version, stamp: digest(source + "\n" + readBounded(path, 1024 * 1024)) };
  }
}
