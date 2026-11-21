import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { lookupSchema, type TimelineData } from "../shared/contracts";
import { parseQuestionnaire } from "../shared/questionnaire";
import { parseGoalQuestionnaire } from "./goal-questionnaire";

export { questionnaireSchema, answerText, selectedLabels } from "../shared/questionnaire";
export type { Questionnaire, Question, Answer } from "../shared/questionnaire";

// Live permission dialogs stay native. Recovery IO belongs to the renderer's RPC.
export const questionnaireTransformer = {
  id: "ask-user-question",
  query: { itemType: "tool_call" },
  transform({ item }) {
    if (item.status !== "completed") return undefined;
    const { name, detail } = item;
    let data: TimelineData | undefined;
    if (detail.type === "unknown") {
      if (name === "ask_user_question") {
        data = parseQuestionnaire(detail.input, detail.output);
      } else if (name === "goal_question" || name === "goal_questionnaire") {
        data = parseGoalQuestionnaire(name, detail.input, detail.output);
      }
    } else if (name === "ask_user_question" && detail.type === "plain_text" && detail.label === "Questions") {
      data = lookupSchema.safeParse({ callId: item.callId, summary: detail.text }).data;
    }
    if (!data) return undefined;
    return { items: [{ type: "plugin", kind: "ask-user-question", version: 1, data }] };
  },
} satisfies PluginTimelineTransformerContribution<"tool_call">;
