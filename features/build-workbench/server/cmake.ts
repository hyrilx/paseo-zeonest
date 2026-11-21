import { mkdirSync, opendirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { ProjectTarget } from "./projects";
import { at, digest, inside, projectDirs, readText, resolveWithin } from "./paths";

const dirFor = (project: string) => `.zeonest-build/cmake/${digest(project).slice(0, 20)}`;
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
  // A child add_subdirectory() file is not an independent project.
  const candidates = lists.has(".") ? ["."] : [...lists.keys()];
  for (const project of candidates) {
    const source = at(project, "CMakeLists.txt");
    try {
      const entry = lists.get(project)!;
      if (project !== "." && !entry.definesProject) continue;
      const dir = dirFor(project);
      const preset = readText(root, at(project, "CMakePresets.json"));
      const inputs = [...lists].filter(([p]) => p !== project && (project === "." || p.startsWith(project + "/"))).sort(([a], [b]) => a.localeCompare(b));
      const stamp = digest(JSON.stringify([entry.hash, preset, inputs]));
      const base = { adapter: "cmake" as const, project, source, cwd: project, requirements: {}, stamp };
      targets.push({ ...base, name: "configure", operation: "probe", cmake: { dir, stamp }, outputs: [] });
      if (preset) notices.push(`${source}：检测到 preset；工作台使用独立 Debug 构建目录，不执行 preset 内的设置。`);
      if (!entry.definesProject) notices.push(`${source}：没有直接声明 project()。可显式尝试独立配置；若需要父工程，请打开父工程。`);
      const saved = readText(root, markerFor(dir), 4096);
      if (!saved) continue;
      const marker = JSON.parse(saved) as { stamp?: string; tool?: string };
      if (marker.stamp !== stamp || !marker.tool) { notices.push(`${source}：入口声明已变化，请重新配置。`); continue; }
      const cache = readText(root, `${dir}/CMakeCache.txt`);
      if (!cache || !cache.split("\n").includes(`CMAKE_HOME_DIRECTORY:INTERNAL=${resolveWithin(root, project)}`)) continue;
      const unavailable = /^fmt_DIR:[^=]+=.*-NOTFOUND$/mu.test(cache) ? "配置未找到 fmt（fmt_DIR-NOTFOUND）；请准备依赖后重新配置。" : undefined;
      if (unavailable) notices.push(`${source}：${unavailable}`);
      for (const item of fileApiTargets(root, dir).slice(0, 96)) {
        targets.push({ ...base, name: item.name, cmake: { dir, stamp, tool: marker.tool }, blocked: unavailable, outputs: item.outputs });
      }
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
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
  const entries = document?.configurations?.find((c) => c.name === "Debug")?.targets;
  if (!Array.isArray(entries)) throw new Error("File API 未返回 Debug 配置");
  return entries.slice(0, 96).flatMap((item) => {
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
    return [{ name: item.name, outputs }];
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
