import { z } from "zod";
import type { Answer, Questionnaire } from "../shared/questionnaire";

type GoalTool = "goal_question" | "goal_questionnaire";
const singleSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).optional(),
  recommended: z.number().int().nonnegative().optional(),
  allow_custom: z.boolean().optional(),
});
const singleArgsSchema = singleSchema.transform((question) => ({ questions: [{ ...question, context: undefined }] }));
const groupArgsSchema = z.object({
  questions: z.array(singleSchema.extend({
    id: z.string(),
    context: z.string().optional(),
    options: z.array(z.string()),
  })).nonempty(),
});
const resultSchema = z.object({
  // This is goal state, not structured answers. Check the envelope without copying the state.
  details: z.object({ version: z.literal(3), goal: z.object({}).nullable() }),
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
});
const separator = "\n\n---\n\n";

export function parseGoalQuestionnaire(name: GoalTool, input: unknown, output: unknown): Questionnaire | undefined {
  const parsed = resultSchema.safeParse(output);
  if (!parsed.success) return;
  const args = (name === "goal_question" ? singleArgsSchema : groupArgsSchema).safeParse(input);
  if (!args.success) return;
  const raw = args.data.questions;

  // Match pi-goal-x's filtering before interpreting the zero-based recommendation.
  const questions = raw.map((item) => ({
    question: item.question,
    ...(item.context ? { context: item.context } : {}),
    options: (item.options ?? []).filter((option) => option.trim()).map((label, index) => ({
      label, ...(index === item.recommended ? { recommended: true } : {}),
    })),
  }));
  const { text } = parsed.data.content[0];
  const cancelled = `The user cancelled the ${name === "goal_question" ? "question" : "questionnaire"}. Continue drafting conversationally.`;
  if (text === cancelled) return { questions, result: { answers: [], cancelled: true } };

  // Use the complete echoed prefix, not generic Q/A markers that may occur in authored text.
  const prefixes = questions.map(({ question, context, options }) => `**Q:** ${question}`
    + (context ? `\n${context}` : "")
    + (options.length ? `\nOptions: ${options.map(({ label }) => label).join(" / ")}` : "")
    + "\n**A:** ");
  const [first, ...rest] = prefixes;
  if (!first || !text.startsWith(first)) return;
  const boundaries = [];
  let start = first.length;
  for (const prefix of rest) {
    const delimiter = separator + prefix;
    const end = text.indexOf(delimiter, start);
    if (end < 0) return;
    boundaries.push({ start, end, delimiter });
    start = end + delimiter.length;
  }
  boundaries.push({ start, end: text.length, delimiter: "" });

  const answers: Answer[] = [];
  for (const [index, { start, end, delimiter }] of boundaries.entries()) {
    // A freeform answer can contain an entire echoed question. A later split is
    // possible if the last boundary that differs can move without moving the next one.
    const next = boundaries[index + 1];
    if (next && text.lastIndexOf(delimiter, next.end - delimiter.length) !== end) return;
    const answer = text.slice(start, end);
    const question = questions[index];
    if (!question || !answer.trim()) return;
    const matches = question.options.filter(({ label }) => label === answer).length;
    const forcedChoice = question.options.length > 0 && raw[index]?.allow_custom === false;
    if (forcedChoice && matches === 0) return;
    // The text does not say whether a matching answer was typed or selected.
    const kind = forcedChoice && matches === 1 ? "option" : matches === 0 ? "custom" : "unspecified";
    answers.push({ questionIndex: index, question: question.question, answer, kind });
  }
  return { questions, result: { answers, cancelled: false } };
}
