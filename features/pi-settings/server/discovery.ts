import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import type { Resource } from "../shared/contracts";
import { isObject, packageEnabled, parseObject, skillMetadata, sourceOf, stringList, type JsonObject } from "../shared/config";
import { canonical, hash, inside, MAX_TEXT } from "./files";

export function resolveResourcePath(path: string, base: string, home: string): string {
  return resolve(path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(base, path));
}
export function packagePath(source: string, base: string, home: string): string {
  if (source.startsWith("npm:")) {
    const name = /^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/.exec(source.slice(4))?.[1];
    if (!name || name.includes("..") || name.startsWith("-") || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error("无效的 npm 包名。");
    return join(base, "npm", "node_modules", name);
  }
  let git = source.replace(/^git:/, "").replace(/^git@([^:]+):/, "https://$1/");
  if (/^(?:https?:\/\/|ssh:\/\/)?[\w.-]+\/.+/.test(git) && (source.startsWith("git:") || /^(?:https?:\/\/|ssh:\/\/|git@)/.test(source))) {
    git = git.replace(/^\w+:\/\//, "").replace(/^[^/]+@(?=[^/]+\/)/, "");
    const slash = git.indexOf("/"); const host = git.slice(0, slash); let path = git.slice(slash + 1);
    path = path.replace(/@.*$/, "").replace(/\.git$/, "");
    const root = join(base, "git"); const full = resolve(root, host, path);
    if (!inside(root, full) || path.split("/").includes("..")) throw new Error("无效的 Git 包路径。");
    return full;
  }
  if (source.startsWith("git:") || /^(https?:\/\/|ssh:\/\/|git@)/.test(source)) throw new Error("不支持此 Git 源格式，请使用 git:host/owner/repository@ref。");
  return resolveResourcePath(source, base, home);
}
export function packageIdentity(source: string, base: string, home: string): string {
  if (source.startsWith("npm:")) return `npm:${relative(join(base, "npm", "node_modules"), packagePath(source, base, home))}`;
  if (/^(git:|https?:\/\/|ssh:\/\/|git@)/.test(source)) return `git:${relative(join(base, "git"), packagePath(source, base, home))}`;
  return `local:${canonical(packagePath(source, base, home))}`;
}
function matchesRule(path: string, pattern: string, base: string, home: string, exact: boolean): boolean {
  const full = resolveResourcePath(pattern, base, home).split("\\").join("/");
  const paths = [path, ...(basename(path) === "SKILL.md" ? [dirname(path)] : [])].map((p) => p.split("\\").join("/"));
  return paths.some((p) => exact ? p === full : minimatch(p, full, { dot: true, matchBase: false }) || minimatch(relative(base, p).split("\\").join("/"), pattern, { dot: true, matchBase: !pattern.includes("/") }));
}
function applyRules(path: string, rules: string[], base: string, home: string, initial: boolean, selection: boolean): boolean {
  if (selection && rules.length === 0) return false;
  const includes = rules.filter((r) => !/^[+!-]/.test(r));
  let enabled = selection && includes.length > 0 ? includes.some((r) => matchesRule(path, r, base, home, false)) : initial;
  if (rules.some((r) => r.startsWith("!") && matchesRule(path, r.slice(1), base, home, false))) enabled = false;
  if (rules.some((r) => r.startsWith("+") && matchesRule(path, r.slice(1), base, home, true))) enabled = true;
  if (rules.some((r) => r.startsWith("-") && matchesRule(path, r.slice(1), base, home, true))) enabled = false;
  return enabled;
}
export interface DiscoveryScope { base: string; scope: "global" | "project"; settings: JsonObject; cwd?: string }
interface Candidate { path: string; root: string; scope: "global" | "project"; kind: "skill" | "extension"; source?: string; enabled: boolean; manifestRules?: string[] }
export function discover(scopes: DiscoveryScope[], home: string) {
  const warnings: string[] = []; const resources: Resource[] = []; const candidates: Candidate[] = [];
  const seen = new Set<string>(); let visited = 0;
  function collect(path: string, root: string, scope: DiscoveryScope["scope"], kind: Candidate["kind"], source?: string, enabled = true, depth = 0) {
    if (++visited > 15_000) throw new Error("资源扫描超过 15000 项，请缩小资源目录或 glob。");
    if (depth > 24 || !existsSync(path)) return;
    const real = canonical(path); const key = `${scope}:${kind}:${real}:${source ?? ""}`;
    if (seen.has(key)) return; seen.add(key);
    const info = statSync(real);
    if (info.isFile()) {
      if (kind === "skill" && extname(path).toLowerCase() !== ".md") return;
      if (kind === "extension" && !/\.[cm]?[jt]s$/.test(path)) return;
      candidates.push({ path, root, scope, kind, source, enabled }); return;
    }
    if (!info.isDirectory()) return;
    if (kind === "extension") {
      const entry = ["index.ts", "index.js", "index.mjs", "index.cjs"].map((file) => join(path, file)).find(existsSync);
      if (entry) { collect(entry, root, scope, kind, source, enabled, depth + 1); return; }
      if (depth > 0) return;
    } else if (existsSync(join(path, "SKILL.md"))) { collect(join(path, "SKILL.md"), root, scope, kind, source, enabled, depth + 1); return; }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      collect(join(path, entry.name), root, scope, kind, source, enabled, depth + 1);
    }
  }
  function addPatterns(patterns: string[], base: string, scope: DiscoveryScope["scope"], kind: Candidate["kind"], source?: string, enabled = true) {
    for (const pattern of patterns) {
      if (/^[-!]/.test(pattern) || pattern.startsWith("builtin:")) continue;
      const input = pattern.replace(/^\+/, "");
      const full = resolveResourcePath(input, base, home);
      const root = /[*?{[]/.test(full) ? full.slice(0, full.search(/[*?{[]/)).replace(/[^/\\]*$/, "") : full;
      for (const path of /[*?{[]/.test(full) ? globSync(full, { exclude: ["**/node_modules/**", "**/.git/**"] }) : [full]) collect(path, root, scope, kind, source, enabled);
    }
  }
  // A project package shadows the same managed installation identity, unless it is an autoload:false delta.
  const project = scopes.find((scope) => scope.scope === "project");
  const projectSources = new Map<string, unknown>();
  for (const entry of Array.isArray(project?.settings.packages) ? project.settings.packages : []) {
    try { projectSources.set(packageIdentity(sourceOf(entry), project!.base, home), entry); }
    catch { warnings.push("项目包声明含无效路径，请在原始配置中修复。"); }
  }
  for (const scope of scopes) {
    try {
      for (const kind of ["skill", "extension"] as const) {
        const plural = kind === "skill" ? "skills" : "extensions";
        collect(join(scope.base, plural), scope.base, scope.scope, kind);
        addPatterns(stringList(scope.settings[plural]), scope.base, scope.scope, kind);
        if (kind === "skill") {
          if (scope.scope === "global") collect(join(home, ".agents", "skills"), join(home, ".agents", "skills"), "global", kind);
          else if (scope.cwd) {
            let current = scope.cwd;
            while (true) {
              collect(join(current, ".agents", "skills"), join(current, ".agents", "skills"), "project", kind);
              if (existsSync(join(current, ".git")) || dirname(current) === current) break;
              current = dirname(current);
            }
          }
        }
      }
      for (const entry of Array.isArray(scope.settings.packages) ? scope.settings.packages : []) {
        const source = sourceOf(entry); if (!source) continue;
        const identity = packageIdentity(source, scope.base, home);
        const globalScope = scopes.find((item) => item.scope === "global");
        if (scope.scope === "project" && isObject(entry) && entry.autoload === false && globalScope && (Array.isArray(globalScope.settings.packages) ? globalScope.settings.packages : []).some((item) => packageIdentity(sourceOf(item), globalScope.base, home) === identity)) continue;
        const projectEntry = projectSources.get(identity);
        if (scope.scope === "global" && projectEntry !== undefined && !(isObject(projectEntry) && projectEntry.autoload === false)) continue;
        const root = packagePath(source, scope.base, home);
        if (!existsSync(root)) { warnings.push(`包尚未安装：${source}（${scope.scope}）`); continue; }
        let manifest: JsonObject = {};
        if (existsSync(join(root, "package.json"))) {
          const metadata = parseObject(readFileSync(join(root, "package.json"), "utf8"));
          if (isObject(metadata.pi)) manifest = metadata.pi;
        }
        for (const kind of ["skill", "extension"] as const) {
          const plural = kind === "skill" ? "skills" : "extensions";
          const patterns = Object.keys(manifest).length ? stringList(manifest[plural]) : [plural];
          const start = candidates.length;
          addPatterns(patterns, root, scope.scope, kind, source, packageEnabled(entry) && !(isObject(entry) && entry.autoload === false));
          for (const candidate of candidates.slice(start)) candidate.manifestRules = patterns.filter((r) => /^[+!-]/.test(r));
        }
      }
    } catch (error) { warnings.push(`资源扫描不完整：${error instanceof Error ? error.message : "读取失败"}`); }
  }
  const emitted = new Set<string>();
  candidates.sort((a, b) => Number(Boolean(b.source)) - Number(Boolean(a.source)) || Number(b.scope === "project") - Number(a.scope === "project"));
  for (const candidate of candidates) {
    try {
      const { path, scope, kind, source } = candidate;
      const canonicalRoot = canonical(candidate.root); const real = canonical(path);
      // Explicitly configured symlink resources are authorized by their resolved discovery root.
      if (!inside(canonicalRoot, real)) {
        warnings.push(`跳过离开资源根的链接：${path}`); continue;
      }
      if (emitted.has(`${kind}:${real}`)) continue;
      let text = "";
      if (statSync(real).size <= MAX_TEXT) text = readFileSync(real, "utf8");
      const owner = scopes.find((x) => x.scope === scope)!;
      let enabled = candidate.enabled;
      if (source) {
        const entry = (Array.isArray(owner.settings.packages) ? owner.settings.packages : []).find((e) => sourceOf(e) === source);
        const rules = isObject(entry) ? entry[kind === "skill" ? "skills" : "extensions"] : undefined;
        const root = packagePath(source, owner.base, home);
        if (!applyRules(path, candidate.manifestRules ?? [], root, home, true, false)) continue;
        if (Array.isArray(rules)) enabled = applyRules(path, stringList(rules), root, home, enabled, !(isObject(entry) && entry.autoload === false));
        const delta = projectSources.get(packageIdentity(source, owner.base, home));
        if (scope === "global" && isObject(delta) && delta.autoload === false) enabled = applyRules(path, stringList(delta[kind === "skill" ? "skills" : "extensions"]), root, home, enabled, false);
      }
      if (!source) enabled = applyRules(path, stringList(owner.settings[kind === "skill" ? "skills" : "extensions"]), owner.base, home, enabled, false);
      let metadata = { name: "", description: "", modelInvocation: true };
      if (kind === "skill") try { metadata = skillMetadata(text); } catch { warnings.push(`技能 frontmatter 无效，Pi 可能不会加载：${path}`); }
      const name = metadata.name || (basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path));
      resources.push({ id: hash(`${scope}\0${source ?? ""}\0${real}`), path, scope, kind, name,
        description: metadata.description, packageSource: source, packageRoot: source ? packagePath(source, owner.base, home) : undefined, enabled, modelInvocation: metadata.modelInvocation });
      emitted.add(`${kind}:${real}`);
    } catch { warnings.push(`无法读取资源：${candidate.path}`); }
  }
  return { resources, warnings };
}
