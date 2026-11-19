import assert from "node:assert/strict";
import test from "node:test";
import { answerText, questionnaireSchema, questionnaireTransformer, selectedLabels } from "../client/transform";
import { questions, result, toolCall, type ToolCall } from "./fixtures/questionnaire";
import { timelineSchema } from "../shared/contracts";

const transform = (item = toolCall(), phase: "streaming" | "complete" = "complete") =>
  questionnaireTransformer.transform({ item, phase });
const withDetail = (input: unknown, output: unknown) =>
  toolCall({ detail: { type: "unknown", input, output } });

test("completed rpiv envelope retains every authored option, description, preview and answer", () => {
  const source = toolCall();
  const before = structuredClone(source);
  const projection = transform(source)!;
  assert.equal(projection.items.length, 1);
  const item = projection.items[0]!;
  assert.equal(item.kind, "ask-user-question");
  assert.equal(item.version, 1);
  const data = questionnaireSchema.parse(item.data);
  assert.deepEqual(data.questions, questions);
  assert.deepEqual(data.result, result);
  assert.deepEqual(source, before);
  assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection);
  assert.equal(data.questions.flatMap((question) => question.options).length, 7);
});

test("history and live completion projections are deterministic and independent of phase", () => {
  assert.deepEqual(transform(), transform(toolCall(), "streaming"));
  assert.deepEqual(transform(), transform(structuredClone(toolCall())));
});

test("selected labels respect option, multi and custom intent", () => {
  const [single, multi, custom] = result.answers;
  assert.deepEqual(selectedLabels(single), ["SQLite (Recommended)"]);
  assert.deepEqual(selectedLabels(multi), ["类型", "测试"]);
  assert.deepEqual(selectedLabels(custom), []);
  assert.deepEqual(selectedLabels(undefined), []);
  assert.equal(answerText(multi!), "类型、测试、另外检查打包内容");
  assert.equal(answerText({ ...custom!, answer: null }), "（空回答）");
});

test("unrelated tools and native running, failed or canceled rows are untouched", () => {
  for (const name of ["AskUserQuestion", "mcp__ask_user_question", "bash", "other_ask_user_question"]) {
    assert.equal(transform(toolCall({ name })), undefined);
  }
  for (const status of ["running", "failed", "canceled"] as const) {
    assert.equal(transform(toolCall({ status } as Partial<ToolCall>)), undefined);
  }
  assert.equal(transform(toolCall({ detail: { type: "plain_text", text: "Q/A" } })), undefined);
});

test("unsupported or malformed arguments/results fall back to the native timeline", () => {
  for (const input of [null, {}, "{invalid", JSON.stringify({ questions }), { questions: [] },
    { questions: [{ ...questions[0], options: [{ label: "缺少说明" }] }] }]) {
    assert.equal(transform(withDetail(input, { details: result })), undefined);
  }
  for (const output of [null, {}, "User has answered your questions", { content: [] },
    { details: { ...result, cancelled: "false" } },
    { details: { ...result, answers: [{ ...result.answers[0], kind: "unknown" }] } },
    { details: { ...result, answers: [{ ...result.answers[0], answer: undefined }] } }]) {
    assert.equal(transform(withDetail({ questions }, output)), undefined);
  }
});

test("ambiguous question mappings never attach an answer to the wrong question", () => {
  const first = result.answers[0]!;
  for (const answers of [
    [{ ...first, questionIndex: 10 }], [{ ...first, questionIndex: -1 }],
    [{ ...first, questionIndex: 0.5 }], [{ ...first, question: "不同问题" }], [first, first],
  ]) {
    assert.equal(transform(withDetail({ questions }, { details: { ...result, answers } })), undefined);
  }
  for (const unanswered of [[8], [0]]) {
    assert.equal(transform(withDetail({ questions }, { details: { ...result, unanswered } })), undefined);
  }
});

test("partial submission, cancellation, notes and error envelopes remain visible", () => {
  for (const extra of [{ cancelled: true }, { unanswered: [1, 2] }, { error: "no_ui" }]) {
    const details = { ...result, answers: [result.answers[0]], ...extra };
    const item = transform(withDetail({ questions }, { details }))!.items[0]!;
    assert.deepEqual(questionnaireSchema.parse(item.data).result, details);
  }
});

test("Paseo 0.15.4 Questions summaries become on-demand lookup rows without inventing options", () => {
  const source = toolCall({ detail: { type: "plain_text", label: "Questions", text: "选择什么？: 第一项" } });
  const projection = transform(source)!;
  assert.deepEqual(projection.items[0]!.data, { callId: source.callId, summary: "选择什么？: 第一项" });
  assert.ok(timelineSchema.safeParse(projection.items[0]!.data).success);
  assert.deepEqual(projection, transform(source, "streaming"));
  assert.equal(transform(toolCall({ detail: { type: "plain_text", label: "Other", text: "Q/A" } })), undefined);
  assert.equal(transform(toolCall({ detail: { type: "plain_text", label: "Questions", text: "x".repeat(262145) } })), undefined);
});

test("renderer payload schema rejects invalid persisted data", () => {
  assert.equal(questionnaireSchema.safeParse({ questions, result }).success, true);
  assert.equal(questionnaireSchema.safeParse({ questions, result: { answers: [] } }).success, false);
});
