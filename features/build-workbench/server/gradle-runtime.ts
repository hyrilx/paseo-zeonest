import { join } from "node:path";
import { lte, gte, valid } from "semver";
import type { Candidate } from "../shared/contracts";
import { at, missing, readBounded, readText } from "./paths";

type Runtime = NonNullable<Candidate["gradleRuntime"]>;

function propertyLines(text: string) {
  return text.split(/\r\n|\n|\r/u).map((line) => line.trim()).filter((line) => line && !/^[#!]/u.test(line));
}

export function wrapperVersion(properties: string) {
  const lines = propertyLines(properties);
  // Do not draw a conclusion from declarations we cannot parse unambiguously.
  if (lines.some((line) => /\\u|\\$/u.test(line) || escapedKey(line))) return;
  const urls = lines.filter((line) => /^distributionUrl(?:\s|=|:|$)/u.test(line));
  const [url] = urls;
  if (urls.length !== 1 || !url) return;
  return /^distributionUrl\s*=\s*https\\?:\/\/(?:services|downloads)\.gradle\.org\/distributions\/gradle-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?)-(?:bin|all)\.zip$/u.exec(url)?.[1];
}

const escapedKey = (line: string) => /^[^\s=:]*\\/u.test(line);

function hasJavaOverride(text: string) {
  // Escaped keys and continuations can hide an override. Ordinary JVM args (e.g. -Xmx) don't select Java.
  return propertyLines(text).some((line) => /^(?:org\.gradle\.java\.home|systemProp\.org\.gradle\.java\.home)(?:\s|=|:|$)/u.test(line) ||
    escapedKey(line) || /\\$/u.test(line) || /org\.gradle\.java\.home/u.test(line));
}

export function gradleJvmOverride(root: string, cwd: string, userHome: string, env: NodeJS.ProcessEnv) {
  try {
    if (readText(root, at(cwd, "gradle/gradle-daemon-jvm.properties"), 64 * 1024) !== undefined) return "项目声明了 daemon JVM criteria";
    if (hasJavaOverride(readText(root, at(cwd, "gradle.properties"), 64 * 1024) ?? "")) return "项目 Gradle 属性可指定独立 JVM";
    try {
      if (hasJavaOverride(readBounded(join(userHome, "gradle.properties"), 64 * 1024))) return "用户 Gradle 属性可指定独立 JVM";
    } catch (error) { if (!missing(error)) throw error; }
  } catch { return "无法读取 Gradle 的 JVM 声明"; }
  if (["GRADLE_OPTS", "JAVA_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "BASH_ENV", "ENV"].some((key) => env[key]) ||
    Object.keys(env).some((key) => /^ORG_GRADLE_PROJECT_org\.gradle\./u.test(key))) return "宿主环境可能覆盖 Gradle 的 JVM";
}

export function javaRelease(home: string) {
  try { return /^JAVA_VERSION="([^"\r\n]+)"/mu.exec(readBounded(join(home, "release"), 32 * 1024))?.[1]; }
  catch { return undefined; }
}

// https://docs.gradle.org/9.5.1/userguide/compatibility.html#java_runtime
// Limit conclusions to stable Wrapper releases covered by this table.
const recent = [["9.4.0", 26], ["9.1.0", 25], ["8.14.0", 24], ["8.10.0", 23], ["8.8.0", 22], ["8.5.0", 21], ["8.3.0", 20], ["7.6.0", 19], ["7.5.0", 18], ["7.3.0", 17]] as const;

export function gradleRuntime(distribution: string | undefined, java: string | undefined, override?: string): Runtime {
  const unknown = (reason: string): Runtime => ({ status: "unknown", reason: `兼容性未确认：${reason}。` });
  if (override) return unknown(override);
  const major = Number(/^(?:1\.)?(\d+)(?:[._+]|$)/u.exec(java ?? "")?.[1]);
  if (!major || !java || /(?:ea|internal)/iu.test(java)) return unknown("无法确认启动 Java 的正式版本");
  if (!distribution) return unknown("无法确认 Gradle 分发版本");
  const version = distribution.split(".").length === 2 ? `${distribution}.0` : distribution;
  const max = valid(version) && lte(version, "9.5.1") && recent.find(([start]) => gte(version, start))?.[1];
  if (!max) return unknown(`Gradle ${distribution} 不在已核对的版本范围内`);
  const min = gte(version, "9.0.0") ? 17 : 8;
  const range = `Gradle ${distribution} 的运行 JVM 要求 Java ${min}–${max}`;
  if (major < min || major > max) return { status: "incompatible", reason: `${range}；启动 Java ${java} 不在范围内。` };
  return { status: "compatible", reason: `${range}；启动 Java ${java} 符合此范围。项目构建仍需单独验证。` };
}
