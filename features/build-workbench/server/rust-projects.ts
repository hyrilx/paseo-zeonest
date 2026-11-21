import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { ancestors } from "./mise";
import { at, inside, readBounded, readText } from "./paths";

type Table = Record<string, unknown>;
export const table = (v: unknown): Table => v && typeof v === "object" && !Array.isArray(v) ? v as Table : {};
export const str = (v: unknown) => typeof v === "string" && v.length ? v : undefined;
export const strings = (v: unknown) => Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
export const toml = (s: string) => table(parse(s));
export function rustPin(root: string, cwd: string) {
  for (const dir of ancestors(cwd)) {
    for (const file of ["rust-toolchain", "rust-toolchain.toml"]) {
      const path = at(dir, file);
      try {
        const text = readText(root, path);
        if (text === undefined) continue;
        const pin = /^\s*\[/u.test(text) || file.endsWith(".toml") ? table(toml(text).toolchain) : { channel: text.trim() };
        const channel = str(pin.channel);
        const selected = str(pin.path);
        if (channel && !selected && /^[\w.-]+$/u.test(channel)) return { rustChannel: channel };
        if (selected && !channel) return { rustPath: resolve(root, dir, selected) };
        throw new Error("需指定有效的 channel 或 path");
      } catch (error) { return { rustIssue: `${path}：无法确认 Rust 工具链（${(error as Error).message}）` }; }
    }
  }
  return {};
}

export type CargoContext = { targetDir: string; buildDir?: string; inputs: unknown[] };
export function cargoContext(root: string, cwd: string, defaultRoot: string, env: NodeJS.ProcessEnv) {
  let targetDir = resolve(root, defaultRoot, "target");
  let buildDir: string | undefined;
  const inputs: unknown[] = [];
  const dir = resolve(root, cwd);
  function readConfig(path: string, base: string) {
    try {
      const text = readBounded(realpathSync(path), 512 * 1024);
      const settings = table(toml(text).build);
      const target = str(settings["target-dir"]);
      if (target) targetDir = resolve(base, target);
      const intermediate = str(settings["build-dir"]);
      if (intermediate) buildDir = resolve(base, intermediate);
      inputs.push([path, text]);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(`${path}：无法确认 Cargo 配置`, { cause: e });
    }
  }
  const home = env.CARGO_HOME || (env.HOME && resolve(env.HOME, ".cargo"));
  if (home && !readConfig(resolve(home, "config"), resolve(home, ".."))) readConfig(resolve(home, "config.toml"), resolve(home, ".."));
  const dirs = [dir];
  while (dirs[0] !== resolve(dirs[0]!, "..")) dirs.unshift(resolve(dirs[0]!, ".."));
  for (const parent of dirs) {
    const config = resolve(parent, ".cargo");
    if (home && config === resolve(home)) continue;
    if (!readConfig(resolve(config, "config"), parent)) readConfig(resolve(config, "config.toml"), parent);
  }
  const override = env.CARGO_TARGET_DIR || env.CARGO_BUILD_TARGET_DIR;
  if (override) targetDir = resolve(dir, override);
  if (env.CARGO_BUILD_BUILD_DIR) buildDir = resolve(dir, env.CARGO_BUILD_BUILD_DIR);
  if (buildDir?.includes("{")) {
    throw new Error("Cargo build.build-dir 含路径模板；当前无法确认共享写入位置");
  }
  return { targetDir: canonicalWrite(targetDir), buildDir: buildDir && canonicalWrite(buildDir), inputs } satisfies CargoContext;
}

export function canonicalWrite(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = resolve(path, "..");
    return parent === path ? path : resolve(canonicalWrite(parent), relative(parent, path));
  }
}

export function localCargoDir(root: string, path: string) {
  return isAbsolute(path) && inside(root, path) && root !== path ? relative(root, path) : undefined;
}

export function dependencyPaths(manifest: Table, workspace: Table) {
  const result: string[] = [];
  const collect = (group: Table) => {
    for (const name of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      for (const [alias, value] of Object.entries(table(group[name]))) {
        const dep = table(value);
        const inherited = dep.workspace === true;
        const path = str((inherited ? table(table(workspace.dependencies)[alias]) : dep).path);
        if (path) result.push(inherited ? `\0${path}` : path);
      }
    }
  };
  collect(manifest);
  for (const group of Object.values(table(manifest.target))) collect(table(group));
  return result;
}
