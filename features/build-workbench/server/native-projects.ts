import { accessSync, constants, statSync } from "node:fs";
import { PROBE_TARGET_LIMIT } from "../shared/contracts";
import type { ProjectTarget } from "./projects";
import { misePin } from "./mise";
import { at, digest, projectDirs, readText, resolveWithin } from "./paths";

export type Gradle = { wrapper?: string; jar?: string };
export type Xcode = { kind: "workspace" | "project"; derived: string };

export function discoverGradle(root: string, dirs: string[], notices: string[], targets: ProjectTarget[]) {
  for (const project of dirs) {
    try {
      const names = ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"];
      const inputs = names.map((name) => readText(root, at(project, name)));
      const index = inputs.findIndex((value) => value !== undefined);
      if (index < 0) continue;
      // A module build file is not a separate invocation root when it lives beneath settings.
      if (index >= 2 && targets.some((t) => t.gradle && (t.project === "." || project.startsWith(t.project + "/")))) continue;
      const source = at(project, names[index]!);
      const wrapper = at(project, "gradlew");
      const jar = at(project, "gradle/wrapper/gradle-wrapper.jar");
      const properties = readText(root, at(project, "gradle/wrapper/gradle-wrapper.properties"));
      let gradle: Gradle = {};
      if (readText(root, wrapper) !== undefined || properties !== undefined) {
        accessSync(resolveWithin(root, wrapper), constants.X_OK);
        if (!properties || !statSync(resolveWithin(root, jar)).isFile()) throw new Error("Gradle Wrapper 缺少配置或 JAR");
        gradle = { wrapper, jar };
      }
      const extra = ["gradle.properties", "gradle/gradle-daemon-jvm.properties", "gradle/libs.versions.toml"].map((name) => readText(root, at(project, name)));
      const buildFiles = dirs.filter((dir) => project === "." || dir.startsWith(project + "/")).slice(0, 128)
        .flatMap((dir) => ["build.gradle.kts", "build.gradle"].flatMap((name) => {
          const path = at(dir, name);
          try { const value = readText(root, path); return value === undefined ? [] : [[path, digest(value)]]; }
          catch { return []; }
        }));
      const miseJava = misePin(project, "java", (path) => readText(root, path));
      const stamp = digest(JSON.stringify([inputs, properties, extra, buildFiles, miseJava]));
      targets.push({ adapter: "gradle", project, source, cwd: project, requirements: { miseJava }, stamp, gradle, name: "tasks --all", operation: "probe", outputs: [] });
    } catch (error) { notices.push(`${project}：${(error as Error).message}`); }
  }
}

export function discoverXcode(root: string, notices: string[], targets: ProjectTarget[]) {
  for (const project of projectDirs(root).dirs.filter((s) => /\.(?:xcworkspace|xcodeproj)$/u.test(s) && !s.includes(".xcodeproj/"))) {
    const kind = project.endsWith(".xcworkspace") ? "workspace" : "project";
    const source = at(project, kind === "workspace" ? "contents.xcworkspacedata" : "project.pbxproj");
    const parent = project.split("/").slice(0, -1).join("/") || ".";
    try {
      const contents = readText(root, source, 2 * 1024 * 1024);
      if (!contents) continue;
      const referenced = kind === "workspace" ? [...contents.matchAll(/location\s*=\s*"(?:group|container):([^"<>]+\.xcodeproj)"/gu)].slice(0, 48).flatMap(([, path]) => {
        try { return [[path, readText(root, at(parent, `${path}/project.pbxproj`), 2 * 1024 * 1024)]]; }
        catch { return []; }
      }) : [];
      const derived = `.zeonest-build/xcode/${digest(project).slice(0, 20)}`;
      targets.push({ adapter: "xcode", project, source, cwd: parent, requirements: {}, stamp: digest(JSON.stringify([contents, referenced])),
        xcode: { kind, derived }, name: "list schemes", operation: "probe", outputs: [] });
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
}

const gradleTask = (name: string) => {
  const task = name.split(":").at(-1) ?? "";
  if (!/^:?(?:[\w-][\w.-]*:)*[\w-][\w.-]*$/u.test(name) || task.startsWith("-") || name.length > 192 || name.split(":").some((part) => part === "." || part === "..")) return false;
  const words = task.replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase().split(/[ ._-]+/u);
  // Release can be a variant of a local build or unit test; it isn't a publishing verb.
  return !words.some((word) => /^(?:publish\w*|deploy\w*|upload\w*|sign|signing|connected\w*|devices?|install\w*|uninstall\w*|archive|run|clean)$/u.test(word)) && !/^(?:init|wrapper|release)$/iu.test(task);
};
const localTask = (task: string) => /^(?:build|assemble|bundle|compile|check|test|lint)(?:$|[A-Z0-9_.-])|^(?:jar|war|distZip|distTar)$|(?:Jar|War|Distributable|Test|Check|Lint)$/u.test(task);
const schemeName = (name: string) => name.length <= 128 && !!name.trim() && !/^\s*-/u.test(name) && !/[\u0000-\u001f\u007f]/u.test(name);

export function gradleTaskPriority(name: string) {
  const pieces = name.split(":");
  const qualified = pieces.length > 2;
  const task = pieces.at(-1) ?? "";
  // In a large multi-module listing Gradle can list hundreds of metadata JARs,
  // aggregates, and intermediate bundle/resource tasks before the variant entries.
  const variantOutput = /^(?:assemble|bundle)[A-Z0-9]/u.test(task) &&
    !/(?:Classes|Resources|Metadata|Test|ToDir|Lint|Aar|Jar)/u.test(task);
  const distribution = /^(?:create.*Distributable|distZip|distTar)$/u.test(task);
  if (qualified && (variantOutput || distribution)) return 4;
  if (/^(?:build|assemble|bundle|package)(?:$|[A-Z0-9_.-])|^(?:jar|war|distZip|distTar)$|(?:Jar|War|Distributable)$/u.test(task)) return qualified ? 3 : 2;
  return qualified ? 1 : 0;
}

export type ProbeTargets = { names: string[]; limited: boolean };
const GRADLE_LINE_LIMIT = 16 * 1024;

export function gradleProbe() {
  let line = "";
  let skippingLine = false;
  let limited = false;
  let sawListing = false;
  let group: string | undefined;
  let inTasks = false;
  let buildGroup = false;
  const retained = new Map<string, number>();

  function acceptLine(text: string) {
    if (group && /^-{3,}\s*$/u.test(text)) {
      inTasks = true;
      sawListing = true;
      buildGroup = /\b(?:build|verification|distribution)s?\b/iu.test(group);
      group = undefined;
      return;
    }
    group = text.includes(" - ") ? undefined : /^([^\s].*?) tasks\s*$/iu.exec(text)?.[1];
    if (group || /^(?:Rules\s*$|To see |BUILD (?:SUCCESSFUL|FAILED)\b)/u.test(text)) inTasks = false;
    if (!inTasks) return;
    const name = /^(:?[\w.:-]+)(?:\s+-\s+.*)?\s*$/u.exec(text)?.[1];
    if (!name || !gradleTask(name) || !(buildGroup || localTask(name.split(":").at(-1) ?? ""))) return;
    const path = name.startsWith(":") ? name : ":" + name;
    if (retained.has(path)) return;
    const priority = gradleTaskPriority(path);
    if (retained.size === PROBE_TARGET_LIMIT) {
      limited = true;
      let victim: string | undefined;
      let lowest = priority;
      for (const [key, item] of retained) {
        if (item < priority && item <= lowest) { lowest = item; victim = key; }
      }
      if (victim === undefined) return;
      retained.delete(victim);
    }
    retained.set(path, priority);
  }

  return {
    push(chunk: string) {
      let from = 0;
      while (from < chunk.length) {
        const newline = chunk.indexOf("\n", from);
        const end = newline < 0 ? chunk.length : newline;
        if (!skippingLine) {
          if (line.length + end - from <= GRADLE_LINE_LIMIT) line += chunk.slice(from, end);
          else { line = ""; skippingLine = true; limited ||= inTasks; group = undefined; }
        }
        if (newline < 0) break;
        if (!skippingLine) acceptLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        line = "";
        skippingLine = false;
        from = newline + 1;
      }
    },
    finish(): ProbeTargets {
      if (!skippingLine && line) acceptLine(line);
      if (!sawListing) throw new Error("Gradle 没有返回可识别的任务列表");
      // Map order is source order, including after an eviction.
      return { names: [...retained.keys()], limited };
    },
  };
}

export function parseXcodeProbe(output: string): ProbeTargets {
  // xcodebuild may print a preamble before the JSON document.
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("xcodebuild 没有返回 scheme JSON");
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { workspace?: { schemes?: unknown }; project?: { schemes?: unknown } };
    const schemes = (parsed.workspace ?? parsed.project)?.schemes ?? [];
    if (!(parsed.workspace || parsed.project) || !Array.isArray(schemes)) throw new Error("scheme 列表缺失");
    const names = [...new Set(schemes.filter((s): s is string => typeof s === "string" && schemeName(s)))];
    return { names: names.slice(0, PROBE_TARGET_LIMIT), limited: names.length > PROBE_TARGET_LIMIT };
  } catch (error) { throw new Error("无法读取 xcodebuild scheme 列表", { cause: error }); }
}

export function nativeTarget(probe: ProjectTarget, name: string): ProjectTarget | undefined {
  if (!probe.operation) return;
  if (probe.xcode && schemeName(name)) return { ...probe, name, operation: undefined, confirmed: true, outputs: [`${probe.xcode.derived}/Build/Products/Debug-iphonesimulator`] };
  if (!probe.gradle || !gradleTask(name)) return;
  const module = name.split(":").slice(1, -1);
  const outputs = module.every((part) => part !== "." && part !== "..") ? [at(probe.project, [...module, "build"].join("/"))] : [];
  return { ...probe, name, operation: undefined, confirmed: true, outputs };
}
