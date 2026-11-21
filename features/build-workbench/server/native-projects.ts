import { accessSync, constants, statSync } from "node:fs";
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

export function parseNativeProbe(adapter: "gradle" | "xcode", output: string): string[] {
  if (adapter === "gradle") {
    let buildGroup = false;
    const names = output.split(/\r?\n/u).flatMap((line) => {
      const group = /^(.+?) tasks\s*$/iu.exec(line)?.[1];
      if (group) { buildGroup = /\b(?:build|verification|distribution)s?\b/iu.test(group); return []; }
      const name = /^(:?[\w.:-]+)(?:\s+-\s+.*)?\s*$/u.exec(line)?.[1];
      return name && gradleTask(name) && (buildGroup || localTask(name.split(":").at(-1)!)) ? [name.startsWith(":") ? name : ":" + name] : [];
    });
    return [...new Set(names)].slice(0, 256);
  }
  // xcodebuild may print a preamble before the JSON document.
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("xcodebuild 没有返回 scheme JSON");
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { workspace?: { schemes?: unknown }; project?: { schemes?: unknown } };
    const schemes = (parsed.workspace ?? parsed.project)?.schemes ?? [];
    if (!(parsed.workspace || parsed.project) || !Array.isArray(schemes)) throw new Error("scheme 列表缺失");
    return [...new Set(schemes.filter((s): s is string => typeof s === "string" && schemeName(s)))].slice(0, 256);
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
