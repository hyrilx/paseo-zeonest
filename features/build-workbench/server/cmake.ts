import { mkdirSync, opendirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ProjectTarget } from "./projects";
import { misePin } from "./mise";
import { at, digest, inside, projectDirs, readText, resolveWithin } from "./paths";

const dirFor = (project: string, preset?: string) => `.zeonest-build/cmake/${digest(preset ? JSON.stringify([project, preset]) : project).slice(0, 20)}`;
const replyFor = (dir: string) => `${dir}/.cmake/api/v1/reply`;
const markerFor = (dir: string) => `${dir}/zeonest-configure.json`;
const basename = (s: unknown): s is string => typeof s === "string" && /^[\w.-]+\.json$/u.test(s);

export function discoverCmake(root: string, notices: string[], targets: ProjectTarget[]) {
  const dirs = projectDirs(root).dirs;
  const lists = new Map<string, { hash: string; definesProject: boolean }>();
  for (const project of dirs) {
    const source = at(project, "CMakeLists.txt");
    try {
      const text = readText(root, source);
      if (text !== undefined) lists.set(project, { hash: digest(text), definesProject: /^\s*project\s*\(/imu.test(text) });
    } catch (error) {
      notices.push(`${source}：${(error as Error).message}`);
      if (project === ".") return;
    }
  }
  for (const [project, entry] of lists) {
    const source = at(project, "CMakeLists.txt");
    try {
      const presets = configurePresets(root, project, notices);
      const miseCmake = misePin([project, "."], "cmake", (path) => readText(root, path));
      if (project !== "." && !entry.definesProject && !presets.names.length) continue;
      const inputs = [...lists].filter(([p]) => p !== project && (project === "." || p.startsWith(project + "/"))).sort(([a], [b]) => a.localeCompare(b));
      if (!entry.definesProject) notices.push(`${source}：没有直接声明 project()。若依赖父工程，请打开父工程执行配置。`);
      for (const preset of [undefined, ...presets.names]) {
        const dir = dirFor(project, preset);
        const stamp = digest(JSON.stringify([entry.hash, inputs, presets.inputs, preset]));
        const base = { adapter: "cmake" as const, project, source, cwd: project, requirements: { miseCmake }, stamp };
        const label = (name: string) => preset ? `${preset} › ${name}` : name;
        targets.push({ ...base, name: preset ? `configure (${preset})` : "configure", operation: "probe", cmake: { dir, stamp, preset }, outputs: [] });
        try {
          const saved = readText(root, markerFor(dir), 4096);
          if (!saved) continue;
          const marker = JSON.parse(saved) as { stamp?: string; tool?: string };
          if (marker.stamp !== stamp || !marker.tool) { notices.push(`${source}：入口声明已变化，请重新配置。`); continue; }
          const cache = readText(root, `${dir}/CMakeCache.txt`);
          if (!cache || !cache.split(/\r?\n/u).includes(`CMAKE_HOME_DIRECTORY:INTERNAL=${resolveWithin(root, project)}`)) continue;
          for (const item of fileApiTargets(root, dir)) {
            targets.push({ ...base, name: label(item.name), cmake: { dir, stamp, preset, target: item.name, configuration: item.configuration, tool: marker.tool }, outputs: item.outputs });
          }
        } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
      }
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
}

function configurePresets(root: string, project: string, notices: string[]) {
  const inputs = new Map<string, string>();
  const names = new Set<string>();
  const visited = new Set<string>();
  const pending = [at(project, "CMakePresets.json"), at(project, "CMakeUserPresets.json")];
  for (let i = 0; i < pending.length && visited.size < 24; i++) {
    const path = pending[i]!;
    if (visited.has(path)) continue;
    visited.add(path);
    try {
      const text = readText(root, path);
      if (text === undefined) continue;
      inputs.set(path, digest(text));
      const doc = JSON.parse(text) as { include?: unknown; configurePresets?: { name?: unknown; hidden?: unknown }[] };
      if (Array.isArray(doc?.configurePresets)) {
        for (const item of doc.configurePresets.slice(0, 32)) {
          if (!item?.hidden && typeof item?.name === "string" && /^[\w][\w.+-]{0,63}$/u.test(item.name)) names.add(item.name);
        }
      }
      const includes = typeof doc?.include === "string" ? [doc.include] : Array.isArray(doc?.include) ? doc.include : [];
      for (const file of includes.slice(0, 24)) {
        if (typeof file !== "string" || isAbsolute(file) || /\$/u.test(file)) continue;
        const parent = path.slice(0, path.lastIndexOf("/") + 1);
        const rel = relative(root, join(root, parent, file));
        if (rel && inside(root, join(root, parent, file))) pending.push(rel);
      }
    } catch (error) { notices.push(`${path}：${(error as Error).message}`); }
  }
  return { inputs: [...inputs], names: [...names].slice(0, 16) };
}

function fileApiTargets(root: string, dir: string) {
  const reply = replyFor(dir);
  const handle = opendirSync(resolveWithin(root, reply));
  const indexes: string[] = [];
  try {
    for (let i = 0, item; i < 2048 && (item = handle.readSync()); i++) {
      if (item.isFile() && /^index-[\w.-]+\.json$/u.test(item.name)) indexes.push(item.name);
    }
  } finally { handle.closeSync(); }
  const newest = indexes.sort().at(-1);
  if (!newest) throw new Error("未找到 CMake File API reply");
  const parse = <T extends object>(name: string): T | null => {
    try { return JSON.parse(readText(root, `${reply}/${name}`) ?? "null") as T | null; }
    catch (error) { throw new Error(`CMake File API JSON 无法读取：${name}`, { cause: error }); }
  };
  const index = parse<{ reply?: { "codemodel-v2"?: { jsonFile?: unknown } } }>(newest);
  const model = index?.reply?.["codemodel-v2"]?.jsonFile;
  if (!basename(model)) throw new Error("未找到 CMake codemodel-v2");
  type Entry = { name?: unknown; jsonFile?: unknown };
  const document = parse<{ configurations?: { name?: string; targets?: Entry[] }[] }>(model);
  const configurations = document?.configurations;
  const config = Array.isArray(configurations)
    ? configurations.find((c) => c?.name === "Debug") ?? configurations[0] : undefined;
  if (!config || !Array.isArray(config.targets)) throw new Error("File API 未返回构建配置");
  const configuration = typeof config.name === "string" && /^[\w][\w.+-]{0,63}$/u.test(config.name) ? config.name : undefined;
  return config.targets.slice(0, 96).flatMap((item) => {
    if (typeof item?.name !== "string" || !/^[\w][\w.+-]{0,127}$/u.test(item.name) || !basename(item.jsonFile)) return [];
    const detail = parse<{ type?: string; artifacts?: { path?: string }[] }>(item.jsonFile);
    if (!detail || !["EXECUTABLE", "STATIC_LIBRARY", "SHARED_LIBRARY", "MODULE_LIBRARY"].includes(detail.type ?? "")) return [];
    const outputs = (Array.isArray(detail.artifacts) ? detail.artifacts : []).slice(0, 8).flatMap((item) => {
      const path = item?.path;
      if (typeof path !== "string") return [];
      const rel = isAbsolute(path) ? relative(root, path) : at(dir, path);
      try { return inside(resolveWithin(root, dir), resolveWithin(root, rel)) ? [rel] : []; }
      catch { return []; }
    });
    return [{ name: item.name, configuration, outputs }];
  });
}

export function prepareCmake(root: string, dir: string) {
  const query = `${dir}/.cmake/api/v1/query`;
  mkdirSync(resolveWithin(root, query), { recursive: true });
  rmSync(resolveWithin(root, markerFor(dir)), { force: true });
  writeFileSync(resolveWithin(root, `${query}/codemodel-v2`), "");
}

export function finishCmake(root: string, dir: string, stamp: string, tool: string) {
  fileApiTargets(root, dir);
  writeFileSync(resolveWithin(root, markerFor(dir)), JSON.stringify({ stamp, tool }));
}
