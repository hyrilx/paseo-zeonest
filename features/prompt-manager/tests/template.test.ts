import assert from "node:assert/strict";
import test from "node:test";
import type { PlaceholderDefinition } from "../shared/contracts";
import {
  analyzeTemplate,
  convertPlaceholderType,
  createInitialValues,
  createSamplePromptDraft,
  isPlaceholderActive,
  renderPrompt,
  renderPromptSegments,
  type PlaceholderValueMap,
} from "../shared/template";

test("discovers placeholders in order, infers optional-line from {{?key}}, and respects \\{{ escapes", () => {
  const template = [
    "处理 {{target}}（字面量 \\{{raw}}）",
    "{{?opt}}附加 {{detail}} 与 {{target}}",
    "{{?paired}}同行闭合 {{mode}}{{/?paired}}",
  ].join("\n");

  const analysis = analyzeTemplate(template, []);
  assert.deepEqual(
    analysis.effectivePlaceholders.map((item) => [item.key, item.type]),
    [
      ["target", "text"],
      ["opt", "optional-line"],
      ["detail", "text"],
      ["paired", "optional-line"],
      ["mode", "text"],
    ],
  );

  const opt = analysis.discovered.find((item) => item.key === "opt");
  assert.deepEqual(opt?.nestedKeys, ["detail", "target"]);
  assert.deepEqual(opt?.controlledLinePreviews, ["附加 {{detail}} 与 {{target}}"]);

  const rendered = renderPrompt(template, analysis.effectivePlaceholders, {
    target: { text: "auth.ts" },
    opt: { included: true },
    detail: { text: "鉴权边界" },
    paired: { included: true },
    mode: { text: "严格" },
  });
  assert.equal(rendered, "处理 auth.ts（字面量 {{raw}}）\n附加 鉴权边界 与 auth.ts\n同行闭合 严格");
});

test("text placeholder supports value and empty string (clearing to blank)", () => {
  const placeholders: PlaceholderDefinition[] = [
    { key: "file", label: "文件", description: "", type: "text", placeholder: "", defaultValue: "main.ts", multiline: false },
  ];
  const template = "检查[{{file}}]完成";

  assert.equal(renderPrompt(template, placeholders, createInitialValues(placeholders)), "检查[main.ts]完成");
  assert.equal(renderPrompt(template, placeholders, { file: { text: "" } }), "检查[]完成");
});

test("select placeholder handles multi-select separator, single-select omission, and allowCustom", () => {
  const multiDef: PlaceholderDefinition = {
    key: "focus",
    label: "关注点",
    description: "",
    type: "select",
    options: ["正确性", "性能", "安全"],
    multiple: true,
    separator: "、",
    allowCustom: true,
    defaultSelected: ["正确性"],
  };

  const singleDef: PlaceholderDefinition = {
    key: "framework",
    label: "框架",
    description: "",
    type: "select",
    options: ["node:test", "Vitest", "Jest"],
    multiple: false,
    separator: ", ",
    allowCustom: true,
    defaultSelected: ["node:test"],
  };

  const template = "关注：{{focus}}；框架：{{framework}}";

  // Multi-select with 2 presets + 1 custom item + 1 typed custom -> joined with separator
  assert.equal(
    renderPrompt(template, [multiDef, singleDef], {
      focus: { selected: ["安全", "正确性"], customItems: ["并发"], customText: "内存" },
      framework: { selected: ["Vitest"], customItems: [], customText: "" },
    }),
    "关注：正确性、安全、并发、内存；框架：Vitest",
  );

  // Multi-select with only 1 preset -> omits separator
  assert.equal(
    renderPrompt(template, [multiDef, singleDef], {
      focus: { selected: ["性能"], customItems: [], customText: "" },
      framework: { selected: [], customItems: [], customText: "Pytest" },
    }),
    "关注：性能；框架：Pytest",
  );

  // Multi-select with only 1 custom text -> omits separator
  assert.equal(
    renderPrompt(template, [multiDef, singleDef], {
      focus: { selected: [], customItems: [], customText: "仅自定义项" },
      framework: { selected: ["Jest"], customItems: [], customText: "" },
    }),
    "关注：仅自定义项；框架：Jest",
  );

  // Nothing selected -> empty string
  assert.equal(
    renderPrompt(template, [multiDef, singleDef], {
      focus: { selected: [], customItems: [], customText: "" },
      framework: { selected: [], customItems: [], customText: "" },
    }),
    "关注：；框架：",
  );

  // Single-select ignores extra selected items and omits separator
  assert.equal(
    renderPrompt("{{framework}}", [singleDef], {
      framework: { selected: ["node:test", "Vitest"], customItems: ["Mocha"], customText: "" },
    }),
    "node:test",
  );
});

test("checkbox placeholder expands to checkedText or uncheckedText", () => {
  const def: PlaceholderDefinition = {
    key: "strict",
    label: "严格模式",
    description: "",
    type: "checkbox",
    checkedText: "请逐行给出修改补丁。",
    uncheckedText: "仅给出简要方向。",
    defaultChecked: false,
  };
  const template = "要求：{{strict}}";
  assert.equal(renderPrompt(template, [def], { strict: { checked: true } }), "要求：请逐行给出修改补丁。");
  assert.equal(renderPrompt(template, [def], { strict: { checked: false } }), "要求：仅给出简要方向。");
});

test("optional-line omits entire line without stray newlines and tracks nested placeholder activity", () => {
  const template = [
    "{{?head}}开头说明：{{shared}}",
    "主体：{{shared}}",
    "{{?middle}}中间可选行：{{only_middle}} + {{shared}}",
    "{{?tail}}结尾可选行：{{only_tail}}",
  ].join("\n");

  const analysis = analyzeTemplate(template, []);
  const values: PlaceholderValueMap = {
    head: { included: false },
    middle: { included: false },
    tail: { included: true },
    shared: { text: "核心模块" },
    only_middle: { text: "不应出现" },
    only_tail: { text: "补充验证" },
  };

  assert.equal(isPlaceholderActive("shared", analysis, values), true);
  assert.equal(isPlaceholderActive("only_middle", analysis, values), false);
  assert.equal(isPlaceholderActive("only_tail", analysis, values), true);

  assert.equal(
    renderPrompt(template, analysis.effectivePlaceholders, values),
    "主体：核心模块\n结尾可选行：补充验证",
  );

  // Turning middle back on re-activates only_middle
  const nextValues: PlaceholderValueMap = { ...values, middle: { included: true } };
  assert.equal(isPlaceholderActive("only_middle", analysis, nextValues), true);
  assert.equal(
    renderPrompt(template, analysis.effectivePlaceholders, nextValues),
    "主体：核心模块\n中间可选行：不应出现 + 核心模块\n结尾可选行：补充验证",
  );
});

test("regular {{key}} configured as optional-line also controls its line", () => {
  const def: PlaceholderDefinition = {
    key: "extra",
    label: "附注行",
    description: "",
    type: "optional-line",
    defaultIncluded: true,
  };
  const template = "第一行\n{{extra}}附注：{{note}}\n第三行";

  assert.equal(
    renderPrompt(template, [def], { extra: { included: false }, note: { text: "忽略" } }),
    "第一行\n第三行",
  );
  assert.equal(
    renderPrompt(template, [def], { extra: { included: true }, note: { text: "保留" } }),
    "第一行\n附注：保留\n第三行",
  );
});

test("single-pass rendering does not recursively expand placeholder-like user input", () => {
  const template = "输入：{{a}} / {{b}}";
  const analysis = analyzeTemplate(template, []);
  const rendered = renderPrompt(template, analysis.effectivePlaceholders, {
    a: { text: "{{b}}" },
    b: { text: "REAL" },
  });
  assert.equal(rendered, "输入：{{b}} / REAL");
});

test("convertPlaceholderType preserves label/description and sample draft renders cleanly", () => {
  const sample = createSamplePromptDraft();
  const initial = createInitialValues(sample.placeholders);
  const rendered = renderPrompt(sample.template, sample.placeholders, initial);
  assert.match(rendered, /重点关注 逻辑正确性、边界条件/);
  assert.match(rendered, /请逐行指出潜在风险/);
  assert.match(rendered, /请补充 node:test 单元测试/);
  assert.doesNotMatch(rendered, /输出格式请采用/);

  const converted = convertPlaceholderType(sample.placeholders[0]!, "checkbox");
  assert.equal(converted.type, "checkbox");
  assert.equal(converted.label, sample.placeholders[0]!.label);
  assert.equal(converted.description, sample.placeholders[0]!.description);
});

test("renderPromptSegments attributes expanded spans and optional lines accurately", () => {
  const sample = createSamplePromptDraft();
  const initial = createInitialValues(sample.placeholders);
  const values: PlaceholderValueMap = {
    ...initial,
    target: { text: "auth.ts" },
  };
  const result = renderPromptSegments(sample.template, sample.placeholders, values);

  assert.equal(result.text, renderPrompt(sample.template, sample.placeholders, values));
  assert.equal(result.lines.length, 3);

  // Line 0: literal + target + literal + focus + literal
  assert.deepEqual(
    result.lines[0]!.segments.map((seg) => [seg.placeholderKey, seg.text]),
    [
      [null, "请帮我审查 "],
      ["target", "auth.ts"],
      [null, " 的代码改动，重点关注 "],
      ["focus", "逻辑正确性、边界条件"],
      [null, "。"],
    ],
  );

  // Line 1: checkbox expansion
  assert.deepEqual(
    result.lines[1]!.segments.map((seg) => seg.placeholderKey),
    ["strict_mode"],
  );

  // Line 2: optional line include_tests with nested test_framework and test_cases
  assert.deepEqual(result.lines[2]!.controllingOptionalKeys, ["include_tests"]);
  assert.deepEqual(
    result.lines[2]!.segments.map((seg) => [seg.placeholderKey, seg.text]),
    [
      [null, "请补充 "],
      ["test_framework", "node:test"],
      [null, " 单元测试，重点覆盖 "],
      ["test_cases", "边界条件与异常路径"],
      [null, "。"],
    ],
  );
});
