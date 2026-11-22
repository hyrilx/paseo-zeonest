import { accessSync, constants, opendirSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";
import { at } from "./paths";

export function ancestors(project: string) {
  const parts = project === "." ? [] : project.split("/");
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("/")).concat(".");
}

export function misePin(project: string, name: string, read: (path: string) => string | undefined) {
  for (const dir of ancestors(project)) {
    for (const file of ["mise.local.toml", ".mise.local.toml", "mise.toml", ".mise.toml", ".config/mise.toml", ".config/mise/config.toml"]) {
      const text = read(at(dir, file));
      if (text === undefined) continue;
      const path = at(dir, file);
      try {
        const { tools } = parse(text);
        if (tools === undefined) continue;
        if (!tools || typeof tools !== "object" || Array.isArray(tools)) throw new Error("[tools] 必须是表");
        if (!Object.hasOwn(tools, name)) continue;
        const entry = (tools as Record<string, unknown>)[name];
        const list = Array.isArray(entry) ? entry : [entry];
        const pins = list.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? (item as { version?: unknown }).version : undefined);
        if (!pins.length || !pins.every((pin) => typeof pin === "string" && /^[\w.+*-][\w.+* -]{0,127}$/u.test(pin))) throw new Error("需声明可验证的版本字符串、版本数组或含 version 的表");
        // mise puts the first version on PATH first; do not substitute later versions.
        return pins[0] as string;
      } catch (error) { throw new Error(`${path}：无法确认 mise 的 ${name} 声明（${(error as Error).message}）`); }
    }
  }
}

export function executable(path: string) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

export function directories(root: string, limit = 64) {
  const found: string[] = [];
  try {
    const dir = opendirSync(root);
    try { for (let i = 0, entry; i < limit && (entry = dir.readSync()); i++) if (entry.isDirectory() && !entry.name.startsWith(".")) found.push(join(root, entry.name)); }
    finally { dir.closeSync(); }
  } catch { /* Optional installation directory. */ }
  return found;
}

export function executables(name: string, env: NodeJS.ProcessEnv) {
  return [...new Set((env.PATH ?? "").split(delimiter).filter(isAbsolute).slice(0, 64).map((dir) => resolve(dir, name)))].filter(executable).slice(0, 10);
}

export function autoInstallRisk(path: string) {
  try { return [path, realpathSync(path)].some((p) => /(?:^|\/)(?:shims|corepack)(?:\/|$)/u.test(p)); }
  catch { return true; }
}

const installs = (env: NodeJS.ProcessEnv) => join(env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local/share"), "mise"), "installs");

export function matchesInstalledAlias(name: string, alias: string, path: string, env: NodeJS.ProcessEnv) {
  if (!/^[\w][\w.+-]*$/u.test(alias)) return false;
  try {
    const installed = realpathSync(join(installs(env), name, alias));
    return statSync(installed).isDirectory() && realpathSync(path).startsWith(installed + "/");
  } catch { return false; }
}

export function installedExecutables(name: string, env: NodeJS.ProcessEnv, preferred?: string) {
  const root = installs(env);
  const sameName = join(root, name);
  const knownPackage = name === "protoc" ? join(root, "protobuf") : sameName;
  const candidates = new Map<string, string>();
  const probe = (paths: string[]) => {
    for (const path of paths) {
      if (!executable(path) || autoInstallRisk(path)) continue;
      try { const real = realpathSync(path); if (!candidates.has(real)) candidates.set(real, path); }
      catch { /* The installation may have been removed. */ }
    }
  };
  const paths = (dir: string) => [join(dir, "bin", name), join(dir, name), join(dir, "Contents/Home/bin", name), join(dir, "Contents/bin", name)];
  const versions = (pkg: string) => [join(pkg, "latest"), ...directories(pkg, 24).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))];
  const preferredPaths = preferred && /^[\w.+-]+$/u.test(preferred) ? paths(join(knownPackage, preferred)) : [];
  probe([...preferredPaths, ...executables(name, env)]);
  for (const pkg of new Set([knownPackage, sameName])) {
    for (const dir of versions(pkg)) {
      probe(paths(dir));
      // Some archives keep their top-level directory and macOS app bundle.
      if (name === "cmake") for (const child of [dir, ...directories(dir, 16)]) probe([join(child, "CMake.app/Contents/bin/cmake"), ...paths(child)]);
    }
  }
  // A mise package can provide executables with names other than its package name.
  if (!candidates.size) for (const pkg of directories(root, 96)) for (const dir of versions(pkg).slice(0, 8)) probe(paths(dir));
  return [...candidates.values()].slice(0, 10);
}
