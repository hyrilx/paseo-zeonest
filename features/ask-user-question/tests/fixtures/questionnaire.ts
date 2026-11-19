import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import type { Question } from "../../client/transform";

export type ToolCall = Parameters<PluginTimelineTransformerContribution<"tool_call">["transform"]>[0]["item"];

// Synthetic data matching rpiv-ask-user-question 2.13.9's tool arguments and
// buildQuestionnaireResponse envelope; no session data or runtime sentinels.
export const questions: Question[] = [
  {
    question: "使用哪种存储？", header: "存储",
    options: [
      { label: "SQLite (Recommended)", description: "单文件，无需额外服务。", preview: "# 配置\n\n```json\n{ \"driver\": \"sqlite\" }\n```" },
      { label: "PostgreSQL", description: "适合多实例并发。", preview: "连接到独立数据库。" },
    ],
  },
  {
    question: "需要哪些检查？", header: "检查", multiSelect: true,
    options: [
      { label: "类型", description: "运行 TypeScript 检查。" },
      { label: "测试", description: "运行回归测试。" },
      { label: "构建", description: "生成双端产物。" },
    ],
  },
  {
    question: "选择部署方式？", header: "部署",
    options: [
      { label: "本地", description: "仅在本机运行。" },
      { label: "远程", description: "部署到服务器。" },
    ],
  },
];

export const result = {
  answers: [
    { questionIndex: 0, question: questions[0]!.question, kind: "option" as const,
      answer: questions[0]!.options[0]!.label, preview: questions[0]!.options[0]!.preview, notes: "先保持简单。" },
    { questionIndex: 1, question: questions[1]!.question, kind: "multi" as const,
      answer: "另外检查打包内容", selected: ["类型", "测试"] },
    // Custom text equal to an option label must stay custom, not mark it selected.
    { questionIndex: 2, question: questions[2]!.question, kind: "custom" as const, answer: "本地" },
  ],
  cancelled: false,
  globalNote: "本轮先不部署。",
};

export function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    type: "tool_call", callId: "question-call-1", name: "ask_user_question",
    status: "completed", error: null,
    detail: { type: "unknown", input: { questions }, output: {
      content: [{ type: "text", text: 'User has answered your questions: "使用哪种存储？"="SQLite (Recommended)". You can now continue with the user\'s answers in mind.' }],
      details: result,
    } },
    ...overrides,
  } as ToolCall;
}
