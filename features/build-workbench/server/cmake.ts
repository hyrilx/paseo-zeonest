import { mkdirSync, opendirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectTarget } from "./projects";
import { misePin } from "./mise";
import { at, digest, inside, projectDirs, readText, resolveWithin } from "./paths";

const dirFor = (project: string, preset?: string) => `.zeonest-build/cmake/${digest(preset ? JSON.stringify([project, preset]) : project).slice(0, 20)}`;
const replyFor = (dir: string) => `${dir}/.cmake/api/v1/reply`;
const markerFor = (dir: string) => `${dir}/zeonest-configure.json`;
export const cmakeBuildDir = (base: string, tool: string, options: string[]) => `${base}/${digest(JSON.stringify([tool, options])).slice(0, 20)}`;
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
      const miseCmake = misePin(project, "cmake", (path) => readText(root, path));
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
          const marker = JSON.parse(saved) as { stamp?: string; tool?: string; context?: string; result?: string };
          if (marker.stamp !== stamp || !marker.tool || !marker.context || !/^[a-f0-9]{20}$/u.test(marker.context)) {
            notices.push(`${source}：入口或配置记录已变化，请重新配置。`); continue;
          }
          const built = at(dir, marker.context);
          const cache = readText(root, `${built}/CMakeCache.txt`);
          if (!cache || !cache.split(/\r?\n/u).includes(`CMAKE_HOME_DIRECTORY:INTERNAL=${resolveWithin(root, project)}`)) continue;
          const model = fileApiResult(root, built, project);
          if (marker.result !== digest(JSON.stringify([cache, model]))) { notices.push(`${source}：CMake 配置输入或生成结果已变化，请重新配置。`); continue; }
          const defaults = /^CMAKE_DEFAULT_BUILD_TYPE:[^=\n]+=(.+)\r?$/mu.exec(cache)?.[1]?.trim();
          const kind = /^CMAKE_GENERATOR:[^=\n]+=(.+)\r?$/mu.exec(cache)?.[1]?.trim();
          const first = /^CMAKE_CONFIGURATION_TYPES:[^=\n]+=([^;\r\n]+)/mu.exec(cache)?.[1];
          const selected = model.configurations.length === 1 ? model.configurations[0] : kind === "Ninja Multi-Config" ? defaults || first : undefined;
          for (const item of model.targets) {
            targets.push({ ...base, name: label(item.name), cmake: { dir: built, stamp, preset, target: item.name, configurations: item.outputs, tool: marker.tool }, outputs: selected === undefined ? [] : item.outputs[selected] ?? [] });
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

function fileApiResult(root: string, dir: string, project: string) {
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
  const index = parse<{ reply?: Record<string, { jsonFile?: unknown }> }>(newest);
  const model = index?.reply?.["codemodel-v2"]?.jsonFile;
  if (!basename(model)) throw new Error("未找到 CMake codemodel-v2");
  const files = index?.reply?.["cmakeFiles-v1"]?.jsonFile;
  if (!basename(files)) throw new Error("未找到 CMake cmakeFiles-v1");
  const records = parse<{ inputs?: { path?: unknown; isGenerated?: boolean; isCMake?: boolean }[] }>(files)?.inputs;
  if (!Array.isArray(records) || records.length > 4096) throw new Error("CMake 配置输入超出读取范围");
  const source = resolveWithin(root, project);
  const inputs = records.flatMap((record) => {
    if (record?.isGenerated || record?.isCMake || typeof record?.path !== "string") return [];
    const abs = resolve(source, record.path);
    if (!inside(root, abs)) return [];
    const rel = relative(root, abs);
    const text = readText(root, rel);
    return [[rel, text === undefined ? null : digest(text)]];
  });
  type Entry = { name?: unknown; jsonFile?: unknown };
  const document = parse<{ configurations?: { name?: string; targets?: Entry[] }[] }>(model);
  const configurations = document?.configurations;
  if (!Array.isArray(configurations) || !configurations.length) throw new Error("File API 未返回构建配置");
  const targets = new Map<string, Record<string, string[]>>();
  for (const config of configurations.slice(0, 32)) {
    if (!config || typeof config.name !== "string" || !/^([\w][\w.+-]{0,63})?$/u.test(config.name) || !Array.isArray(config.targets)) continue;
    for (const item of config.targets.slice(0, 96)) {
      if (typeof item?.name !== "string" || !/^[\w][\w.+-]{0,127}$/u.test(item.name) || !basename(item.jsonFile)) continue;
      const detail = parse<{ type?: string; artifacts?: { path?: string }[] }>(item.jsonFile);
      if (!detail || !["EXECUTABLE", "STATIC_LIBRARY", "SHARED_LIBRARY", "MODULE_LIBRARY"].includes(detail.type ?? "")) continue;
      const outputs = (Array.isArray(detail.artifacts) ? detail.artifacts : []).slice(0, 8).flatMap((item) => {
        const path = item?.path;
        if (typeof path !== "string") return [];
        const rel = isAbsolute(path) ? relative(root, path) : at(dir, path);
        try { resolveWithin(root, rel); return [rel]; }
        catch { return []; }
      });
      const existing = targets.get(item.name) ?? Object.create(null) as Record<string, string[]>;
      existing[config.name] = outputs;
      targets.set(item.name, existing);
    }
  }
  return { configurations: configurations.slice(0, 32).map((c) => c?.name), inputs, targets: [...targets].map(([name, outputs]) => ({ name, outputs })) };
}

export function prepareCmake(root: string, base: string, dir: string) {
  const query = `${dir}/.cmake/api/v1/query`;
  mkdirSync(resolveWithin(root, query), { recursive: true });
  rmSync(resolveWithin(root, markerFor(base)), { force: true });
  writeFileSync(resolveWithin(root, `${query}/codemodel-v2`), "");
  writeFileSync(resolveWithin(root, `${query}/cmakeFiles-v1`), "");
}

export function finishCmake(root: string, project: string, base: string, dir: string, stamp: string, tool: string) {
  const model = fileApiResult(root, dir, project);
  const cache = readText(root, `${dir}/CMakeCache.txt`);
  if (!cache) throw new Error("未找到 CMakeCache.txt");
  const context = dir.slice(base.length + 1);
  writeFileSync(resolveWithin(root, markerFor(base)), JSON.stringify({ stamp, tool, context, result: digest(JSON.stringify([cache, model])) }));
}
