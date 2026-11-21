import { mkdirSync, opendirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { ProjectTarget } from "./projects";
import { misePin } from "./mise";
import { at, digest, inside, missing, projectDirs, readBounded, readText, resolveWithin } from "./paths";
import { canonicalWrite } from "./rust-projects";

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
            targets.push({ ...base, stamp: digest(JSON.stringify([stamp, marker.result])), name: label(item.name), cmake: { dir: built, stamp, preset, target: item.name, configurations: item.outputs,
              writePaths: item.writes, defaultConfig: selected, tool: marker.tool }, outputs: selected === undefined ? [] : item.outputs[selected] ?? [] });
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
  const pending = ["CMakePresets.json", "CMakeUserPresets.json"].map((file) => resolve(resolveWithin(root, project), file));
  const initial = new Set(pending);
  for (let i = 0; i < pending.length && visited.size < 24; i++) {
    const path = pending[i]!;
    if (visited.has(path)) continue;
    visited.add(path);
    try {
      let text: string;
      try { text = readBounded(realpathSync(path), 512 * 1024); }
      catch (e) { if (initial.has(path) && missing(e)) continue; throw e; }
      inputs.set(path, digest(text));
      const doc = JSON.parse(text) as { include?: unknown; configurePresets?: { name?: unknown; hidden?: unknown }[] };
      if (Array.isArray(doc?.configurePresets)) {
        for (const item of doc.configurePresets.slice(0, 32)) {
          if (!item?.hidden && typeof item?.name === "string" && /^[\w][\w.+-]{0,63}$/u.test(item.name)) names.add(item.name);
        }
      }
      const includes = typeof doc?.include === "string" ? [doc.include] : Array.isArray(doc?.include) ? doc.include : [];
      if (includes.length > 24) throw new Error("CMake preset 引用超过读取范围");
      for (const file of includes) {
        if (typeof file !== "string" || /\$/u.test(file)) throw new Error("当前无法确认动态 CMake preset 引用");
        pending.push(resolve(dirname(path), file));
      }
    } catch (error) { notices.push(`${path}：${(error as Error).message}；不复用 preset 配置。`); return { inputs: [], names: [] }; }
  }
  if (pending.some((path) => !visited.has(path))) { notices.push("CMake preset 引用超过读取范围"); return { inputs: [], names: [] }; }
  return { inputs: [...inputs], names: [...names].slice(0, 16) };
}

function fileApiResult(root: string, dir: string, project: string) {
  const reply = replyFor(dir);
  const handle = opendirSync(resolveWithin(root, reply));
  const indexes: string[] = [];
  try {
    for (let i = 0, item; (item = handle.readSync()); i++) {
      if (i >= 2048) throw new Error("CMake File API reply 超出读取范围，请重新配置");
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
  const records = parse<{ inputs?: { path?: unknown }[] }>(files)?.inputs;
  if (!Array.isArray(records) || records.length > 4096) throw new Error("CMake 配置输入超出读取范围，请重新配置");
  const source = resolveWithin(root, project);
  const build = resolveWithin(root, dir);
  let total = 0;
  const inputs = records.map((record) => {
    if (typeof record?.path !== "string" || !record.path || record.path.length > 4096) throw new Error("无法确认 CMake 配置输入，请重新配置");
    // cmakeFiles paths are relative to the source directory, including generated inputs.
    const abs = resolve(source, record.path);
    try {
      const real = realpathSync(abs);
      const text = readBounded(real, 1024 * 1024);
      total += Buffer.byteLength(text);
      if (total > 16 * 1024 * 1024) throw new Error("CMake 配置输入超过 16 MiB");
      return [abs, real, digest(text)];
    } catch (error) { throw new Error(`无法确认 CMake 配置输入：${abs}，请重新配置`, { cause: error }); }
  });
  type Entry = { name?: unknown; jsonFile?: unknown };
  const document = parse<{ configurations?: { name?: string; targets?: Entry[] }[] }>(model);
  const configurations = document?.configurations;
  if (!Array.isArray(configurations) || !configurations.length) throw new Error("File API 未返回构建配置");
  if (configurations.length > 32 || configurations.some((item) => !Array.isArray(item?.targets) || item.targets.length > 512)) throw new Error("CMake File API 构建配置或目标列表超过读取范围");
  const targets = new Map<string, { outputs: Record<string, string[]>; writes: Record<string, string[]> }>();
  for (const config of configurations.slice(0, 32)) {
    if (!config || typeof config.name !== "string" || !/^([\w][\w.+-]{0,63})?$/u.test(config.name) || !Array.isArray(config.targets)) continue;
    for (const item of config.targets) {
      if (typeof item?.name !== "string" || !/^[\w][\w.+-]{0,127}$/u.test(item.name) || !basename(item.jsonFile)) continue;
      const detail = parse<{ type?: string; artifacts?: { path?: string }[] }>(item.jsonFile);
      if (!detail || !["EXECUTABLE", "STATIC_LIBRARY", "SHARED_LIBRARY", "MODULE_LIBRARY"].includes(detail.type ?? "")) continue;
      const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
      if (artifacts.length > 64) throw new Error("CMake File API 产物超过读取范围");
      const outputPaths: string[] = [];
      const writes: string[] = [];
      for (const item of artifacts) {
        if (typeof item?.path !== "string" || !item.path || item.path.length > 4096) continue;
        const abs = resolve(build, item.path);
        const real = canonicalWrite(abs);
        writes.push(real);
        if (!inside(root, abs) || !inside(root, real)) continue;
        const rel = relative(root, abs);
        try { if (rel) { resolveWithin(root, rel); outputPaths.push(rel); } }
        catch { /* External or linked artifacts participate in locks, not browsing. */ }
      }
      const existing = targets.get(item.name) ?? { outputs: Object.create(null) as Record<string, string[]>, writes: Object.create(null) as Record<string, string[]> };
      existing.outputs[config.name] = [...new Set(outputPaths)];
      existing.writes[config.name] = [...new Set(writes)];
      targets.set(item.name, existing);
    }
  }
  return { configurations: configurations.map((c) => c?.name), inputs, targets: [...targets].map(([name, paths]) => ({ name, ...paths })) };
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
