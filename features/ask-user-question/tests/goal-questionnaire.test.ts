import assert from "node:assert/strict";
import test from "node:test";
import { questionnaireSchema, questionnaireTransformer, selectedLabels } from "../client/transform";
import { goalQuestionnaireCall, goalQuestions, goalToolCall } from "./fixtures/goal-questionnaire";

const transform = (item: typeof goalQuestionnaireCall, phase: "streaming" | "complete" = "complete") =>
  questionnaireTransformer.transform({ item, phase });
const review = (item: typeof goalQuestionnaireCall) =>
  questionnaireSchema.parse(transform(item)?.items[0]?.data);

test("pi-goal-x keeps question context, all visible options and the normalized recommendation", () => {
  const source = structuredClone(goalQuestionnaireCall);
  const projection = transform(source)!;
  assert.equal(projection.items[0]!.kind, "ask-user-question");
  assert.deepEqual(source, goalQuestionnaireCall);
  assert.deepEqual(projection, transform(source, "streaming"));
  assert.deepEqual(projection, JSON.parse(JSON.stringify(projection)));
  const { questions, result } = review(source);
  assert.equal(questions[0]!.context, goalQuestions[0]!.context);
  assert.deepEqual(questions[0]!.options, [
    { label: "SQLite" }, { label: "同步 / 远程", recommended: true }, { label: "内存" }, { label: "本地文件" }, { label: "混合存储" },
  ]);
  assert.deepEqual(result.answers.map(({ questionIndex, question, kind, answer }) => [questionIndex, question, kind, answer]), [
    [0, "使用哪种存储？", "option", "同步 / 远程"],
    [1, "在哪里部署？", "unspecified", "本地"],
    [2, "还有什么需要注意？", "custom", "第一行\n\n---\n\n**Q:** 这是答案中的引用。\n**A:** 仍是答案"],
  ]);
  assert.deepEqual(result.answers.map(selectedLabels), [["同步 / 远程"], [], []]);
});

test("pi-goal-x single questions accept omitted options, one option and duplicate labels", () => {
  for (const input of [
    { question: "范围？" },
    { question: "范围？", options: [] },
    { question: "范围？", options: [" "] },
  ]) {
    const { questions, result } = review(goalToolCall("goal_question", input, "**Q:** 范围？\n**A:** 自定范围"));
    assert.deepEqual(questions[0]!.options, []);
    assert.equal(result.answers[0]!.kind, "custom");
  }
  for (const [options, allowCustom, answer, kind] of [
    [["本地"], false, "本地", "option"],
    [["本地"], true, "本地", "unspecified"],
    [["本地", "本地"], false, "本地", "unspecified"],
    [["本地"], true, "两者都要", "custom"],
  ] as const) {
    const input = { question: "范围？", options, recommended: 20, allow_custom: allowCustom };
    const { questions, result } = review(goalToolCall("goal_question", input, `**Q:** 范围？\nOptions: ${options.join(" / ")}\n**A:** ${answer}`));
    assert.deepEqual(questions[0]!.options, options.map((label) => ({ label })));
    assert.equal(result.answers[0]!.kind, kind);
  }
});

test("pi-goal-x cancellations keep their options without inventing answers", () => {
  const single = goalToolCall("goal_question", { question: "范围？", options: ["本地"] },
    "The user cancelled the question. Continue drafting conversationally.");
  const group = goalToolCall("goal_questionnaire", { questions: goalQuestions },
    "The user cancelled the questionnaire. Continue drafting conversationally.");
  for (const call of [single, group]) {
    const { questions, result } = review(call);
    assert.ok(questions[0]!.options.length > 0);
    assert.deepEqual(result, { cancelled: true, answers: [] });
  }
});

test("pi-goal-x leaves malformed, ambiguous and non-question records native", () => {
  const question = { question: "范围？", options: ["本地"], allow_custom: false };
  const single = (text: string) => goalToolCall("goal_question", question, text);
  const input = { questions: [{ id: "x", question: "一？", options: [] }, { id: "y", question: "二？", options: [] }] };
  const group = (text: string) => goalToolCall("goal_questionnaire", input, text);
  const repeat = "\n\n---\n\n**Q:** 二？\n**A:** ";
  for (const call of [
    single("No guided goal draft is active."),
    single("This host cannot display the required goal-drafting dialogs."),
    single("Goal drafting dialog failed: unavailable."),
    single("**Q:** 范围？\nOptions: 远程\n**A:** 远程"),
    single("**Q:** 范围？\nOptions: 本地\n**A:** 远程"),
    single("**Q:** 范围？\nOptions: 本地\n**A:** "),
    group("**Q:** 一？\n**A:** 已回答"),
    group(`**Q:** 一？\n**A:** 前段${repeat}中段${repeat}后段`),
    { ...goalQuestionnaireCall, name: "create_goal" },
    { ...goalQuestionnaireCall, detail: { type: "plain_text", label: "Questions", text: "Q/A" } as const },
    { ...goalQuestionnaireCall, detail: { type: "unknown", input: question, output: null } as const },
    { ...single("**Q:** 范围？\nOptions: 本地\n**A:** 本地"), detail: { type: "unknown", input: question,
      output: { details: { version: 4, goal: null }, content: [{ type: "text", text: "**Q:** 范围？\nOptions: 本地\n**A:** 本地" }] },
    } as const },
  ]) assert.equal(transform(call), undefined);
  for (const status of ["running", "failed", "canceled"] as const) {
    if (status === "failed") assert.equal(transform({ ...goalQuestionnaireCall, status, error: "failed" }), undefined);
    else assert.equal(transform({ ...goalQuestionnaireCall, status, error: null }), undefined);
  }
});

test("repeated questions with identical echoes still pair by order when boundaries are unique", () => {
  const question = { question: "相同题干", options: [] };
  const input = { questions: ["a", "b", "c"].map((id) => ({ id, ...question })) };
  const text = ["甲", "乙", "丙"].map((answer) => `**Q:** 相同题干\n**A:** ${answer}`).join("\n\n---\n\n");
  assert.deepEqual(review(goalToolCall("goal_questionnaire", input, text)).result.answers.map(({ answer }) => answer),
    ["甲", "乙", "丙"]);
});
