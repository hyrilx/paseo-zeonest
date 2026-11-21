import { z } from "zod";

const rpivOptionSchema = z.object({
  label: z.string(), description: z.string(), preview: z.string().optional(),
});
const rpivQuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(rpivOptionSchema).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
const questionSchema = rpivQuestionSchema.extend({
  header: z.string().optional(),
  context: z.string().optional(),
  options: z.array(rpivOptionSchema.extend({
    description: z.string().optional(), recommended: z.boolean().optional(),
  })),
});
const rpivAnswerKindSchema = z.enum(["option", "custom", "multi"]);
const answerSchema = z.object({
  questionIndex: z.number().int().nonnegative(),
  question: z.string(), kind: rpivAnswerKindSchema.or(z.literal("unspecified")),
  answer: z.string().nullable(), selected: z.array(z.string()).optional(),
  notes: z.string().optional(), preview: z.string().optional(),
});
const resultSchema = z.object({
  answers: z.array(answerSchema), cancelled: z.boolean(),
  globalNote: z.string().optional(), unanswered: z.array(z.number().int().nonnegative()).optional(),
  error: z.string().optional(),
});
export const questionnaireSchema = z.object({
  questions: z.array(questionSchema).nonempty(),
  result: resultSchema,
});
export type Questionnaire = z.infer<typeof questionnaireSchema>;
export type Question = Questionnaire["questions"][number];
export type Answer = Questionnaire["result"]["answers"][number];

const rpivArgsSchema = z.object({ questions: z.array(rpivQuestionSchema).min(1).max(4) });
const rpivEnvelopeSchema = z.object({
  details: resultSchema.extend({ answers: z.array(answerSchema.extend({ kind: rpivAnswerKindSchema })) }),
});

export function parseQuestionnaire(input: unknown, output: unknown): Questionnaire | undefined {
  const args = rpivArgsSchema.safeParse(input);
  const envelope = rpivEnvelopeSchema.safeParse(output);
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
