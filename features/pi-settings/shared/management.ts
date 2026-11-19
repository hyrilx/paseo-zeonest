import { isObject, parseObject, setProperty, type JsonObject } from "./config";
import type { SubscriptionCatalog } from "./contracts";

// A missing or entirely unmatched model scope means all available models in Pi.
export function subscriptionScope(catalog: SubscriptionCatalog, patterns: string[]) {
  const resolved = new Map(catalog.rules.map((rule) => [rule.pattern, rule.matches]));
  const available = new Set(catalog.models.map(({ provider, id }) => `${provider}/${id}`));
  const matches = (pattern: string) => {
    const native = resolved.get(pattern);
    if (native) return native;
    if (available.has(pattern)) return [{ ref: pattern }];
    const split = pattern.lastIndexOf(":");
    const ref = pattern.slice(0, split), thinking = pattern.slice(split + 1);
    if (split > 0 && available.has(ref) && /^(off|minimal|low|medium|high|xhigh|max)$/.test(thinking)) return [{ ref, thinking }];
    return undefined;
  };
  const active = new Map<string, string | undefined>();
  for (const pattern of patterns) {
    const items = matches(pattern);
    if (!items) return null;
    for (const item of items) if (!active.has(item.ref)) active.set(item.ref, "thinking" in item ? item.thinking : undefined);
  }
  if (!active.size) for (const ref of available) active.set(ref, undefined);
  return { active, matches };
}

export function toggleSubscriptionModel(catalog: SubscriptionCatalog, patterns: string[], ref: string, enabled: boolean) {
  const scope = subscriptionScope(catalog, patterns);
  if (!scope) throw new Error("匹配规则已更改，请重新读取目录后再切换模型。");
  if (scope.active.has(ref) === enabled) return patterns;
  if (enabled) return [...patterns, ref];
  if (scope.active.size <= 1) throw new Error("至少保留一个模型；空范围在 Pi 中表示全部可用模型。");
  scope.active.delete(ref);
  // Materialize only rules that include the removed model. Keep unrelated rules and their precedence.
  const kept: string[] = [];
  for (const pattern of patterns) {
    const models = scope.matches(pattern) ?? [];
    if (!models.some((model) => model.ref === ref)) kept.push(pattern);
    else for (const model of models) if (scope.active.has(model.ref)) {
      const thinking = scope.active.get(model.ref);
      kept.push(thinking ? `${model.ref}:${thinking}` : model.ref);
    }
  }
  const represented = new Set(kept.flatMap((pattern) => scope.matches(pattern)?.map((model) => model.ref) ?? []));
  for (const [model, thinking] of scope.active) if (!represented.has(model)) kept.push(thinking ? `${model}:${thinking}` : model);
  if (kept.length > 2000) throw new Error("模型范围超过 2000 条规则；请缩小目录后再切换。");
  return [...new Set(kept)];
}

export function npmName(source: string): string | undefined {
  const name = source.startsWith("npm:") ? source.slice(4) : "";
  return name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ? name : undefined;
}

export function githubRepository(source: string): string | undefined {
  const path = /^(?:git:(?:https:\/\/)?|https:\/\/)github\.com\/([\w-]+\/[\w.-]+?)(?:\.git)?$/i.exec(source)?.[1];
  const repo = path?.split("/")[1];
  return path && repo !== "." && repo !== ".." ? path : undefined;
}

export function canCheckPackage(source: string): boolean {
  return Boolean(npmName(source) || githubRepository(source));
}

const modifier = (value: string) => /^[+-]/.test(value);
export function resolveCodemode(global: string[] | undefined, project?: string[]): boolean {
  const entries = project === undefined ? global ?? [] : global && project.every(modifier) ? [...global, ...project] : project;
  let count = entries.filter((item) => item === "codemode").length;
  for (const item of entries) {
    if (item === "+codemode" && !count) count++;
    if (item === "-codemode" && count) count--;
  }
  return count > 0;
}

export function codemodeToolRules(rules: string[] | undefined, always: boolean): string[] | undefined {
  // A lone plain `codemode` means there are no other default tools. Removing it must leave [].
  if (!always && rules?.length === 0) return [];
  const kept = rules?.filter((rule) => !/^[+-]?codemode$/.test(rule)) ?? [];
  if (always && rules?.length === 0) return ["codemode"];
  if (always && rules?.includes("codemode") && !kept.some((rule) => !modifier(rule))) return ["codemode", ...kept];
  if (always) return [...kept, "+codemode"];
  if (!kept.length) return rules?.some((rule) => !modifier(rule)) ? [] : undefined;
  if (rules?.includes("codemode") && kept.every(modifier)) return ["-read", "-bash", "-edit", "-write", ...kept];
  return kept;
}

export function mergeMcpImport(current: string, incoming: string) {
  let input: unknown;
  try { input = JSON.parse(incoming); } catch { throw new Error("请粘贴标准 JSON，不含注释或尾随逗号。"); }
  const mcpServers = isObject(input) ? input.mcpServers : undefined;
  if (!isObject(mcpServers) || !Object.keys(mcpServers).length) throw new Error("请粘贴包含 mcpServers 的 JSON 对象。");
  const existing = parseObject(current).mcpServers;
  let text = current;
  for (const [name, value] of Object.entries(mcpServers)) {
    if (!name.trim() || /[\x00-\x1f]/.test(name) || ["__proto__", "prototype", "constructor"].includes(name) || !isObject(value)) throw new Error("服务器名称或配置不合法。");
    if (isObject(existing) && Object.hasOwn(existing, name)) throw new Error(`已存在同名服务器 ${name}；请先重命名导入项。`);
    text = setProperty(text, ["mcpServers", name], value);
  }
  return text;
}

export function customModels(document: JsonObject) {
  const providers = isObject(document.providers) ? document.providers : {};
  return Object.entries(providers).flatMap(([provider, config]) =>
    isObject(config) && Array.isArray(config.models) ? config.models.flatMap((model: unknown) =>
      isObject(model) && typeof model.id === "string" ? [{ provider, id: model.id, context: String(model.contextWindow ?? ""), maxOutput: String(model.maxTokens ?? ""), reasoning: model.reasoning === true, images: Array.isArray(model.input) && model.input.includes("image") }] : []) : []);
}
