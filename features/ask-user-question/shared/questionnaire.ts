import { z } from "zod";

const questionSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(z.object({
    label: z.string(), description: z.string(), preview: z.string().optional(),
  })).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
const answerSchema = z.object({
  questionIndex: z.number().int().nonnegative(),
  question: z.string(), kind: z.enum(["option", "custom", "multi"]),
  answer: z.string().nullable(), selected: z.array(z.string()).optional(),
  notes: z.string().optional(), preview: z.string().optional(),
});
const resultSchema = z.object({
  answers: z.array(answerSchema), cancelled: z.boolean(),
  globalNote: z.string().optional(), unanswered: z.array(z.number().int().nonnegative()).optional(),
  error: z.string().optional(),
});
export const questionnaireSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
  result: resultSchema,
});
export type Questionnaire = z.infer<typeof questionnaireSchema>;
export type Question = Questionnaire["questions"][number];
export type Answer = Questionnaire["result"]["answers"][number];

export function parseQuestionnaire(input: unknown, output: unknown): Questionnaire | undefined {
  const args = z.object({ questions: questionnaireSchema.shape.questions }).safeParse(input);
  const envelope = z.object({ details: resultSchema }).safeParse(output);
  if (!args.success || !envelope.success) return;
  const { questions } = args.data;
  const result = envelope.data.details;
  const seen = new Set<number>();
  for (const answer of result.answers) {
    if (questions[answer.questionIndex]?.question !== answer.question || seen.has(answer.questionIndex)) return;
    seen.add(answer.questionIndex);
  }
  if (result.unanswered?.some((index) => !questions[index] || seen.has(index))) return;
  return { questions, result };
}

export function selectedLabels(answer: Answer | undefined): readonly string[] {
  if (answer?.kind === "option") return answer.answer === null ? [] : [answer.answer];
  if (answer?.kind === "multi") return answer.selected ?? [];
  return [];
}
export function answerText(answer: Answer): string {
  const parts = answer.kind === "multi"
    ? [...(answer.selected ?? []), ...(answer.answer ? [answer.answer] : [])]
    : answer.answer === null ? [] : [answer.answer];
  return parts.join("、") || "（空回答）";
}

// Paseo 0.15.4's rpiv adapter discards arguments when making this summary.
export function nativeSummary({ result }: Questionnaire): string {
  return result.error ?? (result.cancelled ? "Cancelled" : result.answers
    .map((answer) => `${answer.question}: ${answer.kind === "multi" ? (answer.selected ?? []).join(", ") : (answer.answer ?? "")}`)
    .join("\n"));
}
