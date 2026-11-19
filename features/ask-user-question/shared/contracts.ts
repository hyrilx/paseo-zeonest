import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { questionnaireSchema } from "./questionnaire";

export const lookupSchema = z.object({
  callId: z.string().min(1).max(2048),
  summary: z.string().max(262144),
});
export const timelineSchema = z.union([questionnaireSchema, lookupSchema]);
export type TimelineData = z.infer<typeof timelineSchema>;
export const recoverQuestionnaire = defineRpc({
  name: "zeonest.ask-user-question.recover",
  input: lookupSchema.extend({ agentId: z.string().min(1).max(2048) }),
  output: questionnaireSchema.nullable(),
});
