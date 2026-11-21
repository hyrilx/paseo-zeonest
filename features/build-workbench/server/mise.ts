import { accessSync, constants, opendirSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { array, literal, section } from "./manifests";
import { at } from "./paths";

export function misePin(dirs: string[], name: string, read: (path: string) => string | undefined) {
  for (const dir of new Set(dirs)) {
    const text = read(at(dir, "mise.toml")) ?? read(at(dir, ".mise.toml")) ?? read(at(dir, ".config/mise.toml"));
    if (!text) continue;
    const tools = section(text, "tools");
    const pin = literal(tools, name) ?? array(tools, name)[0];
    if (pin) return pin;
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

export function installedExecutables(name: string, env: NodeJS.ProcessEnv, preferred?: string) {
  const data = env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local/share"), "mise");
  const root = join(data, "installs");
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
