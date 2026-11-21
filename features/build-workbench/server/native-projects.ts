import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProjectTarget } from "./projects";
import { literal, section } from "./manifests";
import { at, digest, projectDirs, readText, resolveWithin } from "./paths";

export type Gradle = { wrapper: string; distribution: string; version: string; android?: string; usesAndroid: boolean };
export type Xcode = { workspace: string; schemes: string[]; derived: string; usesGradle: boolean };

export function discoverGradle(root: string, notices: string[], targets: ProjectTarget[]) {
  for (const project of projectDirs(root).dirs) {
    const source = at(project, "settings.gradle.kts");
    try {
      const settings = readText(root, source);
      if (!settings) continue;
      const gradle = gradleProject(root, project);
      const props = readText(root, at(project, "gradle.properties"));
      const modules = [...settings.matchAll(/\binclude\(\s*"(:[\w-]+)"\s*\)/gu)].map((match) => match[1]!);
      const found = modules.slice(0, 64).flatMap((name) => {
        const path = at(project, name.slice(1));
        const manifest = readText(root, at(path, "build.gradle.kts"));
        if (!manifest) return [];
        const task = /\bid\("com\.android\.application"\)/u.test(manifest) ? "assembleDebug"
          : /\bcompose\.desktop\s*\{/u.test(manifest) ? "createDistributable" : undefined;
        return task ? [{ name: `${name}:${task}`, path, task, manifest }] : [];
      });
      const stamp = digest(JSON.stringify([settings, gradle, props, found]));
      const base = { adapter: "gradle" as const, project, source, cwd: project, requirements: {}, stamp, gradle };
      targets.push({ ...base, name: "tasks --all", operation: "probe", outputs: [] });
      for (const entry of found) {
        const output = entry.task === "assembleDebug" ? "build/outputs/apk/debug" : "build/compose/binaries/main/app";
        targets.push({ ...base, name: entry.name, outputs: [at(entry.path, output)] });
      }
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
}

export function gradleProject(root: string, project: string): Gradle {
  const wrapper = at(project, "gradlew");
  const directory = at(project, "gradle/wrapper");
  const properties = readText(root, `${directory}/gradle-wrapper.properties`);
  if (!properties) throw new Error("缺少 Gradle Wrapper 配置");
  accessSync(resolveWithin(root, wrapper), constants.X_OK);
  if (!lstatSync(resolveWithin(root, `${directory}/gradle-wrapper.jar`)).isFile()) throw new Error("缺少 Gradle Wrapper JAR");
  const url = /^distributionUrl=(\S+)$/mu.exec(properties)?.[1]?.replaceAll("\\:", ":");
  const version = /^https:\/\/services\.gradle\.org\/distributions\/gradle-(\d+\.\d+(?:\.\d+)?)-(?:bin|all)\.zip$/u.exec(url ?? "")?.[1];
  if (!version || !url || !/^distributionBase=GRADLE_USER_HOME$/mu.test(properties) || !/^distributionPath=wrapper\/dists$/mu.test(properties)
      || !/^zipStoreBase=GRADLE_USER_HOME$/mu.test(properties) || !/^zipStorePath=wrapper\/dists$/mu.test(properties)) {
    throw new Error("当前只验证使用标准位置和官方发行 URL 的 Gradle Wrapper");
  }
  if (readText(root, at(project, "gradle/gradle-daemon-jvm.properties")) !== undefined) throw new Error("Gradle daemon JVM criteria 会覆盖工作台选定的 JDK，当前不运行此配置");
  const catalog = readText(root, at(project, "gradle/libs.versions.toml"));
  const raw = catalog ? literal(section(catalog, "versions"), "android_sdk_compile") : undefined;
  const android = raw && /^\d{2}$/u.test(raw) ? raw : undefined;
  const settings = readText(root, at(project, "settings.gradle.kts")) ?? "";
  const usesAndroid = !!android || /\binclude\(\s*":app"\s*\)/u.test(settings);
  if (usesAndroid && /^\s*sdk\.dir\s*[:=]/mu.test(readText(root, at(project, "local.properties")) ?? "")) {
    throw new Error("local.properties 的 sdk.dir 会覆盖工具链，当前未验证该配置");
  }
  return { wrapper, distribution: url, version, android, usesAndroid };
}

export function gradleCache(gradle: Gradle, env: NodeJS.ProcessEnv) {
  const home = env.GRADLE_USER_HOME ?? join(env.HOME ?? homedir(), ".gradle");
  const zip = gradle.distribution.split("/").at(-1)!;
  const hash = BigInt("0x" + createHash("md5").update(gradle.distribution).digest("hex")).toString(36);
  const parent = join(home, "wrapper/dists", zip.slice(0, -4), hash);
  const distribution = join(parent, `gradle-${gradle.version}`, "bin/gradle");
  try {
    if (!lstatSync(join(parent, `${zip}.ok`)).isFile()) return undefined;
    const children: string[] = [];
    const handle = opendirSync(parent);
    try {
      for (let n = 0, entry; (entry = handle.readSync()); n++) {
        if (n >= 32 || entry.isSymbolicLink()) return undefined;
        if (entry.isDirectory()) children.push(entry.name);
      }
    } finally { handle.closeSync(); }
    if (children.length !== 1 || children[0] !== `gradle-${gradle.version}`) return undefined;
    if (!lstatSync(distribution).isFile()) return undefined;
    accessSync(distribution, constants.X_OK);
    if (!lstatSync(join(parent, children[0], `lib/gradle-launcher-${gradle.version}.jar`)).isFile()) return undefined;
    return { home, distribution };
  } catch { return undefined; }
}

function sharedSchemes(root: string, project: string) {
  const dir = at(project, "xcshareddata/xcschemes");
  const names: [string, string][] = [];
  try {
    const handle = opendirSync(resolveWithin(root, dir));
    try {
      for (let n = 0, item; n < 96 && (item = handle.readSync()); n++) {
        if (!item.isFile() || !/^[\w .-]{1,80}\.xcscheme$/u.test(item.name) || item.name.startsWith("-")) continue;
        const scheme = readText(root, at(dir, item.name));
        if (scheme?.includes("<BuildAction")) names.push([item.name.slice(0, -9), digest(scheme)]);
      }
    } finally { handle.closeSync(); }
  } catch { /* A workspace can have no shared schemes of its own. */ }
  return names;
}

export function discoverXcode(root: string, notices: string[], targets: ProjectTarget[]) {
  for (const project of projectDirs(root).dirs.filter((s) => s.endsWith(".xcworkspace") && !s.includes(".xcodeproj/"))) {
    const source = at(project, "contents.xcworkspacedata");
    const parent = project.split("/").slice(0, -1).join("/") || ".";
    try {
      const contents = readText(root, source);
      if (!contents) continue;
      const names = new Map(sharedSchemes(root, project));
      const projects: string[] = [];
      let usesGradle = false;
      for (const item of [...contents.matchAll(/location\s*=\s*"group:([\w./ -]+\.xcodeproj)"/gu)].slice(0, 24)) {
        const ref = at(parent, item[1]!);
        const pbx = readText(root, at(ref, "project.pbxproj"));
        if (!pbx) continue;
        projects.push(digest(pbx));
        if (/\bgradlew\b/u.test(pbx)) usesGradle = true;
        for (const [scheme, hash] of sharedSchemes(root, ref)) names.set(scheme, hash);
      }
      const schemes = [...names.keys()].slice(0, 48);
      const derived = `.zeonest-build/xcode/${digest(project).slice(0, 20)}`;
      const xcode = { workspace: project, schemes, derived, usesGradle };
      const gradle = usesGradle ? gradleProject(root, ".") : undefined;
      const base = { adapter: "xcode" as const, project, source, cwd: parent, requirements: {}, stamp: digest(JSON.stringify([contents, projects, [...names], xcode, gradle])), xcode, gradle };
      targets.push({ ...base, name: "list schemes", operation: "probe", outputs: [] });
      for (const scheme of schemes) targets.push({ ...base, name: scheme, outputs: [`${derived}/Build/Products/Debug-iphonesimulator`] });
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
}

export function parseNativeProbe(adapter: "gradle" | "xcode", output: string): string[] {
  if (adapter === "gradle") return [...new Set([...output.matchAll(/^(:?[\w-]+:(?:assembleDebug|createDistributable))(?:\s+-\s+.*)?\s*$/gmu)].map(([, name]) => name!.startsWith(":") ? name! : ":" + name))].slice(0, 64);
  // xcodebuild may print a preamble before the JSON document.
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("xcodebuild 没有返回 scheme JSON");
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { workspace?: { schemes?: unknown } };
    if (!Array.isArray(parsed.workspace?.schemes)) throw new Error("scheme 列表缺失");
    return parsed.workspace.schemes.filter((s): s is string => typeof s === "string" && /^[\w .-]{1,80}$/u.test(s) && !s.startsWith("-")).slice(0, 64);
  } catch (error) { throw new Error("无法读取 xcodebuild scheme 列表", { cause: error }); }
}
