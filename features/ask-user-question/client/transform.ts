import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { lookupSchema } from "../shared/contracts";
import { parseQuestionnaire } from "../shared/questionnaire";

export { questionnaireSchema, answerText, selectedLabels } from "../shared/questionnaire";
export type { Questionnaire, Question, Answer } from "../shared/questionnaire";

// Live permission dialogs stay native. Recovery IO belongs to the renderer's RPC.
export const questionnaireTransformer = {
  id: "ask-user-question",
  query: { itemType: "tool_call" },
  transform({ item }) {
    if (item.name !== "ask_user_question" || item.status !== "completed") return undefined;
    let data;
    if (item.detail.type === "unknown") {
      data = parseQuestionnaire(item.detail.input, item.detail.output);
    } else if (item.detail.type === "plain_text" && item.detail.label === "Questions") {
      const parsed = lookupSchema.safeParse({ callId: item.callId, summary: item.detail.text });
      if (parsed.success) data = parsed.data;
    }
    if (!data) return undefined;
    return { items: [{ type: "plugin", kind: "ask-user-question", version: 1, data }] };
  },
} satisfies PluginTimelineTransformerContribution<"tool_call">;
