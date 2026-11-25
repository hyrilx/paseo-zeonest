import type {
  CheckboxPlaceholder,
  OptionalLinePlaceholder,
  PlaceholderDefinition,
  PlaceholderType,
  PromptDraft,
  SelectPlaceholder,
  TextPlaceholder,
} from "./contracts";

export interface PlaceholderTextValue {
  text: string;
}

export interface PlaceholderSelectValue {
  selected: string[];
  customItems: string[];
  customText: string;
}

export interface PlaceholderCheckboxValue {
  checked: boolean;
}

export interface PlaceholderOptionalLineValue {
  included: boolean;
}

export type PlaceholderValue =
  | PlaceholderTextValue
  | PlaceholderSelectValue
  | PlaceholderCheckboxValue
  | PlaceholderOptionalLineValue;

export type PlaceholderValueMap = Record<string, PlaceholderValue>;

export interface ParsedLine {
  index: number;
  raw: string;
  /** Optional-line placeholder keys controlling whether this line is kept. */
  controllingOptionalKeys: string[];
  /** Non-optional placeholders referenced on this line (in appearance order). */
  valueKeys: string[];
  /** Preview of this line with optional-line control markers stripped. */
  preview: string;
}

export interface DiscoveredPlaceholder {
  key: string;
  inferredType: "text" | "optional-line";
  /** True when discovered via {{?key}} syntax. */
  hasOptionalMarker: boolean;
  /** Lines where this placeholder appears. */
  lineIndexes: number[];
  /** For each occurrence as a value placeholder, the controlling optional-line keys on that line. */
  occurrenceConditions: string[][];
  /** For optional-line placeholders, preview snippets of controlled lines. */
  controlledLinePreviews: string[];
  /** For optional-line placeholders, inner placeholder keys used on controlled lines. */
  nestedKeys: string[];
}

export interface TemplateAnalysis {
  lines: ParsedLine[];
  discovered: DiscoveredPlaceholder[];
  /** Effective placeholders in template order (merging configured definitions with discovered defaults). */
  effectivePlaceholders: PlaceholderDefinition[];
  /** Configured placeholders that are not currently referenced in the template. */
  unusedPlaceholders: PlaceholderDefinition[];
}

interface RawToken {
  start: number;
  end: number;
  kind: "placeholder" | "optional-open" | "optional-close";
  key: string;
}

const TOKEN_PATTERN = /\\?\{\{([^{}\r\n]+?)\}\}/g;

function scanLineTokens(line: string): RawToken[] {
  const tokens: RawToken[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(line)) !== null) {
    const raw = match[0];
    if (raw.startsWith("\\")) continue; // Escaped literal \{{...}}
    const inner = match[1]?.trim() ?? "";
    if (!inner) continue;
    if (inner.startsWith("?")) {
      const key = inner.slice(1).trim();
      if (!key || key.startsWith("?") || key.startsWith("/")) continue;
      tokens.push({ start: match.index, end: match.index + raw.length, kind: "optional-open", key });
    } else if (inner.startsWith("/?")) {
      const key = inner.slice(2).trim();
      if (!key || key.startsWith("?") || key.startsWith("/")) continue;
      tokens.push({ start: match.index, end: match.index + raw.length, kind: "optional-close", key });
    } else if (!inner.startsWith("/")) {
      tokens.push({ start: match.index, end: match.index + raw.length, kind: "placeholder", key: inner });
    }
  }
  return tokens;
}

export function createDefaultPlaceholder(key: string, type: PlaceholderType = "text"): PlaceholderDefinition {
  const base = { key, label: "", description: "" };
  switch (type) {
    case "text":
      return { ...base, type: "text", placeholder: "", defaultValue: "", multiline: false };
    case "select":
      return { ...base, type: "select", options: ["选项 1", "选项 2"], multiple: true, separator: "、", allowCustom: false, defaultSelected: [] };
    case "checkbox":
      return { ...base, type: "checkbox", checkedText: "", uncheckedText: "", defaultChecked: false };
    case "optional-line":
      return { ...base, type: "optional-line", defaultIncluded: true };
  }
}

export function convertPlaceholderType(current: PlaceholderDefinition, nextType: PlaceholderType): PlaceholderDefinition {
  if (current.type === nextType) return current;
  const fresh = createDefaultPlaceholder(current.key, nextType);
  return {
    ...fresh,
    label: current.label,
    description: current.description,
  };
}

export function placeholderDisplayName(placeholder: Pick<PlaceholderDefinition, "key" | "label">): string {
  return placeholder.label.trim() || placeholder.key;
}

export function analyzeTemplate(
  template: string,
  configured: readonly PlaceholderDefinition[] = [],
): TemplateAnalysis {
  const configuredMap = new Map<string, PlaceholderDefinition>();
  for (const item of configured) {
    if (!configuredMap.has(item.key)) configuredMap.set(item.key, item);
  }

  const rawLines = template.length === 0 ? [] : template.split(/\r?\n/);
  const discoveredMap = new Map<string, DiscoveredPlaceholder>();
  const lines: ParsedLine[] = [];

  function ensureDiscovered(key: string, fromOptionalMarker: boolean): DiscoveredPlaceholder {
    let entry = discoveredMap.get(key);
    if (!entry) {
      entry = {
        key,
        inferredType: fromOptionalMarker ? "optional-line" : "text",
        hasOptionalMarker: fromOptionalMarker,
        lineIndexes: [],
        occurrenceConditions: [],
        controlledLinePreviews: [],
        nestedKeys: [],
      };
      discoveredMap.set(key, entry);
    } else if (fromOptionalMarker) {
      entry.hasOptionalMarker = true;
      entry.inferredType = "optional-line";
    }
    return entry;
  }

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]!;
    const tokens = scanLineTokens(raw);
    const controllingOptionalKeys: string[] = [];
    const valueKeys: string[] = [];

    // Pass 1: identify optional-line controllers on this line
    for (const token of tokens) {
      if (token.kind === "optional-open") {
        if (!controllingOptionalKeys.includes(token.key)) controllingOptionalKeys.push(token.key);
        const entry = ensureDiscovered(token.key, true);
        if (!entry.lineIndexes.includes(index)) entry.lineIndexes.push(index);
      } else if (token.kind === "placeholder" && configuredMap.get(token.key)?.type === "optional-line") {
        if (!controllingOptionalKeys.includes(token.key)) controllingOptionalKeys.push(token.key);
        const entry = ensureDiscovered(token.key, false);
        if (!entry.lineIndexes.includes(index)) entry.lineIndexes.push(index);
      }
    }

    // Build preview string with optional-line markers stripped
    let preview = "";
    let cursor = 0;
    for (const token of tokens) {
      const isOptionalControl =
        token.kind === "optional-open" ||
        token.kind === "optional-close" ||
        (token.kind === "placeholder" && configuredMap.get(token.key)?.type === "optional-line");
      if (isOptionalControl) {
        preview += raw.slice(cursor, token.start);
        cursor = token.end;
      }
    }
    preview += raw.slice(cursor);
    preview = preview.replace(/\\\{\{/g, "{{");

    // Pass 2: identify value placeholders on this line
    for (const token of tokens) {
      if (token.kind !== "placeholder") continue;
      if (configuredMap.get(token.key)?.type === "optional-line") continue;
      // If a key was marked via {{?key}} somewhere and NOT explicitly configured as another type, skip treating it as value
      const existing = discoveredMap.get(token.key);
      if (!configuredMap.has(token.key) && existing?.hasOptionalMarker) {
        if (!controllingOptionalKeys.includes(token.key)) controllingOptionalKeys.push(token.key);
        continue;
      }
      if (!valueKeys.includes(token.key)) valueKeys.push(token.key);
      const entry = ensureDiscovered(token.key, false);
      if (!entry.lineIndexes.includes(index)) entry.lineIndexes.push(index);
      entry.occurrenceConditions.push([...controllingOptionalKeys]);
    }

    for (const optKey of controllingOptionalKeys) {
      const entry = discoveredMap.get(optKey);
      if (!entry) continue;
      if (preview.trim()) entry.controlledLinePreviews.push(preview.trim());
      for (const innerKey of valueKeys) {
        if (!entry.nestedKeys.includes(innerKey)) entry.nestedKeys.push(innerKey);
      }
    }

    lines.push({ index, raw, controllingOptionalKeys, valueKeys, preview });
  }

  const discovered = [...discoveredMap.values()];
  const effectivePlaceholders: PlaceholderDefinition[] = discovered.map((item) => {
    const existing = configuredMap.get(item.key);
    if (existing) return existing;
    return createDefaultPlaceholder(item.key, item.inferredType);
  });

  const discoveredKeys = new Set(discovered.map((item) => item.key));
  const unusedPlaceholders = configured.filter((item) => !discoveredKeys.has(item.key));

  return { lines, discovered, effectivePlaceholders, unusedPlaceholders };
}

export function createInitialValues(placeholders: readonly PlaceholderDefinition[]): PlaceholderValueMap {
  const values: PlaceholderValueMap = {};
  for (const def of placeholders) {
    switch (def.type) {
      case "text":
        values[def.key] = { text: def.defaultValue };
        break;
      case "select": {
        const optionSet = new Set(def.options);
        const initial = def.defaultSelected.filter((item) => optionSet.has(item));
        values[def.key] = {
          selected: def.multiple ? initial : initial.slice(0, 1),
          customItems: [],
          customText: "",
        };
        break;
      }
      case "checkbox":
        values[def.key] = { checked: def.defaultChecked };
        break;
      case "optional-line":
        values[def.key] = { included: def.defaultIncluded };
        break;
    }
  }
  return values;
}

export function isOptionalLineIncluded(
  def: OptionalLinePlaceholder | undefined,
  value: PlaceholderValue | undefined,
): boolean {
  if (value && "included" in value) return value.included;
  return def?.defaultIncluded ?? true;
}

export function isPlaceholderActive(
  key: string,
  analysis: TemplateAnalysis,
  values: PlaceholderValueMap,
): boolean {
  const defMap = new Map(analysis.effectivePlaceholders.map((p) => [p.key, p]));
  const def = defMap.get(key);
  if (!def || def.type === "optional-line") return true;
  const discovered = analysis.discovered.find((item) => item.key === key);
  if (!discovered || discovered.occurrenceConditions.length === 0) return true;
  // Active if at least one occurrence is on an included line
  return discovered.occurrenceConditions.some((controllers) =>
    controllers.every((optKey) => {
      const optDef = defMap.get(optKey);
      return isOptionalLineIncluded(optDef?.type === "optional-line" ? optDef : undefined, values[optKey]);
    }),
  );
}

export function resolveSelectItems(def: SelectPlaceholder, value: PlaceholderValue | undefined): string[] {
  const state: PlaceholderSelectValue =
    value && "selected" in value
      ? value
      : { selected: def.multiple ? def.defaultSelected : def.defaultSelected.slice(0, 1), customItems: [], customText: "" };

  const customTyped = def.allowCustom ? state.customText.trim() : "";

  if (!def.multiple) {
    // Single-select mode: either one preset OR one custom text, never joined with separator.
    if (def.allowCustom && customTyped.length > 0 && state.selected.length === 0) {
      return [customTyped];
    }
    const firstPreset = state.selected.find((item) => item.length > 0);
    if (firstPreset !== undefined) return [firstPreset];
    if (def.allowCustom) {
      const firstCustom = state.customItems.find((item) => item.trim().length > 0)?.trim();
      if (firstCustom) return [firstCustom];
      if (customTyped.length > 0) return [customTyped];
    }
    return [];
  }

  // Multi-select mode: preserve option order for selected presets, then custom items + typed custom text
  const selectedSet = new Set(state.selected);
  const result: string[] = [];
  for (const option of def.options) {
    if (selectedSet.has(option) && option.length > 0) result.push(option);
  }
  // Include any selected item that wasn't in options (defensive)
  for (const item of state.selected) {
    if (item.length > 0 && !result.includes(item)) result.push(item);
  }
  if (def.allowCustom) {
    for (const item of state.customItems) {
      const trimmed = item.trim();
      if (trimmed.length > 0 && !result.includes(trimmed)) result.push(trimmed);
    }
    if (customTyped.length > 0 && !result.includes(customTyped)) {
      result.push(customTyped);
    }
  }
  return result;
}

export function renderPlaceholderValue(def: PlaceholderDefinition, value: PlaceholderValue | undefined): string {
  switch (def.type) {
    case "text": {
      const state = value && "text" in value ? value : { text: def.defaultValue };
      return state.text;
    }
    case "select": {
      const items = resolveSelectItems(def, value);
      if (items.length === 0) return "";
      if (items.length === 1) return items[0]!;
      return items.join(def.separator);
    }
    case "checkbox": {
      const checked = value && "checked" in value ? value.checked : def.defaultChecked;
      return checked ? def.checkedText : def.uncheckedText;
    }
    case "optional-line":
      return "";
  }
}

export function renderPrompt(
  template: string,
  placeholders: readonly PlaceholderDefinition[],
  values: PlaceholderValueMap,
): string {
  const analysis = analyzeTemplate(template, placeholders);
  const defMap = new Map(analysis.effectivePlaceholders.map((item) => [item.key, item]));
  const outputLines: string[] = [];

  for (const line of analysis.lines) {
    const included = line.controllingOptionalKeys.every((optKey) => {
      const def = defMap.get(optKey);
      return isOptionalLineIncluded(def?.type === "optional-line" ? def : undefined, values[optKey]);
    });
    if (!included) continue;

    const tokens = scanLineTokens(line.raw);
    let rendered = "";
    let cursor = 0;

    for (const token of tokens) {
      rendered += line.raw.slice(cursor, token.start).replace(/\\\{\{/g, "{{");
      cursor = token.end;

      if (token.kind === "optional-open" || token.kind === "optional-close") {
        continue;
      }

      const def = defMap.get(token.key);
      if (!def || def.type === "optional-line") {
        continue;
      }
      rendered += renderPlaceholderValue(def, values[token.key]);
    }

    rendered += line.raw.slice(cursor).replace(/\\\{\{/g, "{{");
    outputLines.push(rendered);
  }

  return outputLines.join("\n");
}

export function createSamplePromptDraft(): PromptDraft {
  const template = [
    "请帮我审查 {{target}} 的代码改动，重点关注 {{focus}}。",
    "{{strict_mode}}",
    "{{?include_tests}}请补充 {{test_framework}} 单元测试，重点覆盖 {{test_cases}}。",
    "{{?output_style}}输出格式请采用：{{format}}。",
  ].join("\n");

  const placeholders: PlaceholderDefinition[] = [
    {
      key: "target",
      label: "审查目标",
      description: "文件路径、模块名或功能描述，可留空",
      type: "text",
      placeholder: "例如：features/prompt-manager/shared/template.ts",
      defaultValue: "",
      multiline: false,
    } satisfies TextPlaceholder,
    {
      key: "focus",
      label: "关注维度",
      description: "支持多选与自定义补充，单选时自动省略间隔符",
      type: "select",
      options: ["逻辑正确性", "边界条件", "性能开销", "安全性", "可读性"],
      multiple: true,
      separator: "、",
      allowCustom: true,
      defaultSelected: ["逻辑正确性", "边界条件"],
    } satisfies SelectPlaceholder,
    {
      key: "strict_mode",
      label: "严格模式",
      description: "决定反馈详细程度",
      type: "checkbox",
      checkedText: "请逐行指出潜在风险，并给出可直接应用的修复建议。",
      uncheckedText: "请优先总结最关键的 2~3 个问题，保持简洁。",
      defaultChecked: true,
    } satisfies CheckboxPlaceholder,
    {
      key: "include_tests",
      label: "附带测试建议",
      description: "控制是否包含单元测试要求这一行",
      type: "optional-line",
      defaultIncluded: true,
    } satisfies OptionalLinePlaceholder,
    {
      key: "test_framework",
      label: "测试框架",
      description: "单选测试框架，也支持自填",
      type: "select",
      options: ["node:test", "Vitest", "Jest"],
      multiple: false,
      separator: ", ",
      allowCustom: true,
      defaultSelected: ["node:test"],
    } satisfies SelectPlaceholder,
    {
      key: "test_cases",
      label: "重点覆盖场景",
      description: "希望补充测试的边界或异常路径",
      type: "text",
      placeholder: "例如：空输入、并发冲突",
      defaultValue: "边界条件与异常路径",
      multiline: false,
    } satisfies TextPlaceholder,
    {
      key: "output_style",
      label: "指定输出格式",
      description: "可选：明确回复排版结构",
      type: "optional-line",
      defaultIncluded: false,
    } satisfies OptionalLinePlaceholder,
    {
      key: "format",
      label: "输出格式",
      description: "选择偏好的回复格式",
      type: "select",
      options: ["按严重程度分组的 Markdown 列表", "精简摘要 + 代码 Diff", "纯检查清单"],
      multiple: false,
      separator: " / ",
      allowCustom: true,
      defaultSelected: ["按严重程度分组的 Markdown 列表"],
    } satisfies SelectPlaceholder,
  ];

  return {
    name: "代码审查模板",
    description: "涵盖填空、多选/单选、勾选与可选行嵌套占位符的完整示例",
    tags: ["代码审查", "示例"],
    template,
    placeholders,
  };
}
