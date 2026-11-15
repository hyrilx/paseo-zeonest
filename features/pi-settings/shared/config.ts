import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { parseDocument } from "yaml";

export type JsonObject = Record<string, unknown>;
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseObject(text: string): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !isObject(value)) throw new Error("配置必须是有效的 JSON/JSONC 对象；请修复语法后重试。");
  return value;
}
/** Edit only the selected property; comments, unrelated fields, indentation and CRLF survive. */
export function setProperty(text: string, path: (string | number)[], value: unknown): string {
  parseObject(text);
  const indent = /\n([\t ]+)\S/.exec(text)?.[1] ?? "  ";
  return applyEdits(text, modify(text, path, value, {
    formattingOptions: { insertSpaces: !indent.includes("\t"), tabSize: indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  }));
}
export function sourceOf(entry: unknown): string {
  return typeof entry === "string" ? entry : isObject(entry) && typeof entry.source === "string" ? entry.source : "";
}
export const resourceTypes = ["extensions", "skills", "prompts", "themes"] as const;
export function packageEnabled(entry: unknown): boolean {
  return !isObject(entry) || !resourceTypes.every((key) => Array.isArray(entry[key]) && entry[key].length === 0);
}
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
export function resourceRules(text: string, kind: "skill" | "extension", path: string, enabled: boolean): string {
  const key = kind === "skill" ? "skills" : "extensions";
  const current = stringList(parseObject(text)[key]);
  const next = current.filter((item) => item !== `+${path}` && item !== `-${path}`);
  next.push(`${enabled ? "+" : "-"}${path}`);
  return setProperty(text, [key], next);
}
export function resourceLoading(text: string, resource: { kind: "skill" | "extension"; path: string; scope: "global" | "project"; packageSource?: string; packageRoot?: string }, enabled: boolean, project: boolean): string {
  const key = resource.kind === "skill" ? "skills" : "extensions";
  if (!resource.packageSource) {
    // Pi resolves explicit project paths before global resources. A +/- rule alone cannot shadow a global source.
    if (project && resource.scope === "global") {
      const paths = stringList(parseObject(text)[key]);
      if (!paths.includes(resource.path)) text = setProperty(text, [key], [...paths, resource.path]);
    }
    return resourceRules(text, resource.kind, resource.path, enabled);
  }
  if (!resource.packageRoot) throw new Error("缺少包资源根，请重新读取。");
  const root = resource.packageRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const path = resource.path.replace(/\\/g, "/");
  if (!path.startsWith(`${root}/`)) throw new Error("单文件包不支持资源筛选，请通过包声明管理引用。");
  const relative = path.slice(root.length + 1);
  const config = parseObject(text); const packages = Array.isArray(config.packages) ? [...config.packages] : [];
  const source = project && resource.scope === "global" && !/^(npm:|git:|https?:\/\/|ssh:\/\/|git@)/.test(resource.packageSource) ? resource.packageRoot : resource.packageSource;
  const index = packages.findIndex((entry) => sourceOf(entry) === source);
  if (index < 0 && !(project && resource.scope === "global")) throw new Error("当前范围未配置这个包，请重新读取。");
  const previous = index >= 0 ? packages[index] : { source, autoload: false };
  const entry: JsonObject = isObject(previous) ? { ...previous } : { source };
  const current = Array.isArray(entry[key]) ? stringList(entry[key]) : [];
  const rules = Array.isArray(entry[key]) && current.length === 0 && entry.autoload !== false ? ["!**/*"] : current;
  entry[key] = [...rules.filter((rule) => rule !== `+${relative}` && rule !== `-${relative}`), `${enabled ? "+" : "-"}${relative}`];
  if (index >= 0) packages[index] = entry; else packages.push(entry);
  return setProperty(text, ["packages"], packages);
}
function skillFrontmatter(text: string) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  if (!match) throw new Error("技能必须包含已闭合的 YAML frontmatter。");
  const document = parseDocument(match[2]!);
  if (document.errors.length || !isObject(document.toJS({ maxAliasCount: 50 }))) throw new Error("技能 YAML frontmatter 无效。");
  return { match, document };
}
export function skillMetadata(text: string): { name: string; description: string; modelInvocation: boolean } {
  const { document } = skillFrontmatter(text);
  return { name: typeof document.get("name") === "string" ? String(document.get("name")) : "", description: typeof document.get("description") === "string" ? String(document.get("description")) : "", modelInvocation: document.get("disable-model-invocation") !== true };
}
export function setModelInvocation(text: string, enabled: boolean): string {
  const { match, document } = skillFrontmatter(text);
  document.set("disable-model-invocation", !enabled);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const next = document.toString().trimEnd().replace(/\r?\n/g, eol);
  return match[1] + next + match[3] + text.slice(match[0].length);
}
export function effectiveMcp(global: JsonObject, project: JsonObject): JsonObject {
  const result: JsonObject = { ...(isObject(global.mcpServers) ? global.mcpServers : {}) };
  for (const [name, entry] of Object.entries(isObject(project.mcpServers) ? project.mcpServers : {})) {
    const inherited = result[name];
    const override = isObject(entry) && !["command", "url", "type"].some((key) => Object.hasOwn(entry, key));
    Object.defineProperty(result, name, { enumerable: true, configurable: true, writable: true,
      value: override && isObject(inherited) ? { ...inherited, ...Object.fromEntries(["enabled", "exposure", "toolExposure"].filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]])) } : entry });
  }
  return result;
}
export function validateConfig(kind: string, text: string, project: boolean): JsonObject {
  const value = parseObject(text);
  if (kind === "settings") {
    for (const key of ["extensions", "skills", "prompts", "themes", "enabledModels"]) {
      if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every((x: unknown) => typeof x === "string"))) throw new Error(`${key} 必须是字符串数组。`);
    }
    for (const key of ["defaultProvider", "defaultModel"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`${key} 必须是字符串。`);
    if (value.defaultThinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.defaultThinkingLevel))) throw new Error("不支持的思考等级。");
    if (value.packages !== undefined && (!Array.isArray(value.packages) || value.packages.some((x: unknown) => !sourceOf(x)))) throw new Error("packages 必须包含非空 source。");
    if (Array.isArray(value.packages)) for (const entry of value.packages) if (isObject(entry)) for (const key of resourceTypes) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || !entry[key].every((x: unknown) => typeof x === "string"))) throw new Error(`包的 ${key} 筛选必须是字符串数组。`);
    }
  }
  if (kind === "models") {
    if (project) throw new Error("Pi 只支持全局 models.json。");
    if (value.providers !== undefined && !isObject(value.providers)) throw new Error("providers 必须是对象。");
    for (const [name, entry] of Object.entries(isObject(value.providers) ? value.providers : {})) {
      if (!name || !isObject(entry)) throw new Error("供应商必须是命名对象。");
      if (entry.baseUrl !== undefined && (typeof entry.baseUrl !== "string" || !/^https?:\/\//.test(entry.baseUrl))) throw new Error(`${name}: baseUrl 必须是 HTTP(S) URL。`);
      if (entry.models !== undefined && (!Array.isArray(entry.models) || entry.models.some((m: unknown) => !isObject(m) || typeof m.id !== "string" || !m.id.trim()))) throw new Error(`${name}: models 中每项必须有非空 id。`);
    }
  }
  if (kind === "mcp") {
    try { JSON.parse(text); } catch { throw new Error("Pi 的 mcp.json 必须为标准 JSON（不支持注释、BOM 或尾随逗号）。"); }
    if (value.mcpServers !== undefined && !isObject(value.mcpServers)) throw new Error("mcpServers 必须是对象。");
    const names = new Set<string>();
    for (const [name, entry] of Object.entries(isObject(value.mcpServers) ? value.mcpServers : {})) {
      const normalized = name.replace(/-/g, "_");
      if (!/^[\w-]+$/.test(name) || names.has(normalized) || !isObject(entry)) throw new Error("MCP 名称无效、重复，或配置不是对象。");
      names.add(normalized);
      if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error(`${name}: enabled 必须是布尔值。`);
      if (entry.exposure !== undefined && !["codemode", "codemode-deferred", "deferred", "direct", "hidden"].includes(String(entry.exposure))) throw new Error(`${name}: exposure 无效。`);
      if (entry.type !== undefined && !["stdio", "http", "streamable-http"].includes(String(entry.type))) throw new Error(`${name}: 不支持此传输类型（不支持 SSE）。`);
      const transport = ["command", "url", "type"].some((key) => Object.hasOwn(entry, key));
      if (!transport && !project) throw new Error(`${name}: 全局条目必须有 command 或 url。`);
      if (transport && (Boolean(entry.command) === Boolean(entry.url))) throw new Error(`${name}: 必须且只能提供 command 或 url。`);
      if (entry.command !== undefined && (typeof entry.command !== "string" || !entry.command.trim())) throw new Error(`${name}: command 必须是可执行文件。`);
      if (entry.url !== undefined && (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url))) throw new Error(`${name}: url 必须是 HTTP(S) URL。`);
      for (const key of ["env", "headers", "toolExposure"]) if (entry[key] !== undefined && (!isObject(entry[key]) || Object.values(entry[key]).some((x) => typeof x !== "string"))) throw new Error(`${name}: ${key} 必须是字符串映射。`);
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((x: unknown) => typeof x !== "string"))) throw new Error(`${name}: args 必须是字符串数组。`);
    }
  }
  return value;
}
