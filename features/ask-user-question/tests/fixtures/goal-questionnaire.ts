import { toolCall } from "./questionnaire";

// Synthetic tool args and result matching pi-goal-x 0.34.1 and Paseo's unknown detail.
export function goalToolCall(name: "goal_question" | "goal_questionnaire", input: unknown, text: string) {
  return toolCall({ name, detail: {
    type: "unknown", input,
    output: { details: { version: 3, goal: null }, content: [{ type: "text", text }] },
  } });
}

export const goalQuestions = [
  { id: "storage", question: "使用哪种存储？", context: "需要在离线环境运行。\n\n**A:** 是结果标记，也是上下文里的普通文本。",
    options: ["  ", "SQLite", "同步 / 远程", "内存", "本地文件", "混合存储"], recommended: 1, allow_custom: false },
  { id: "deployment", question: "在哪里部署？", options: ["本地", "远程"] },
  { id: "notes", question: "还有什么需要注意？", options: [] },
];

export const goalQuestionnaireCall = goalToolCall("goal_questionnaire", { questions: goalQuestions },
  "**Q:** 使用哪种存储？\n需要在离线环境运行。\n\n**A:** 是结果标记，也是上下文里的普通文本。"
  + "\nOptions: SQLite / 同步 / 远程 / 内存 / 本地文件 / 混合存储\n**A:** 同步 / 远程"
  + "\n\n---\n\n**Q:** 在哪里部署？\nOptions: 本地 / 远程\n**A:** 本地"
  + "\n\n---\n\n**Q:** 还有什么需要注意？\n**A:** 第一行\n\n---\n\n**Q:** 这是答案中的引用。\n**A:** 仍是答案");
