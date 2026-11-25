import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_PROMPTS = 500;
export const MAX_PROMPT_NAME_LENGTH = 120;
export const MAX_PROMPT_DESCRIPTION_LENGTH = 500;
export const MAX_PROMPT_TEMPLATE_LENGTH = 32_768;
export const MAX_PLACEHOLDERS = 100;
export const MAX_OPTIONS = 100;
export const MAX_TAGS = 16;
export const MAX_TAG_LENGTH = 32;
export const MAX_TEXT_FIELD_LENGTH = 4_096;

const promptId = z.string().trim().min(1).max(128);
const revision = z.uuid();
const placeholderKey = z.string().trim().min(1).max(80).refine(
  (value) => !/[{}\r\n]/.test(value) && !value.startsWith("?") && !value.startsWith("/"),
  "占位符标识不能包含花括号、换行或以 ? / 开头",
);

const placeholderBase = z.object({
  key: placeholderKey,
  label: z.string().max(120).default(""),
  description: z.string().max(300).default(""),
});

export const textPlaceholderSchema = placeholderBase.extend({
  type: z.literal("text"),
  placeholder: z.string().max(200).default(""),
  defaultValue: z.string().max(MAX_TEXT_FIELD_LENGTH).default(""),
  multiline: z.boolean().default(false),
});

export const selectPlaceholderSchema = placeholderBase.extend({
  type: z.literal("select"),
  options: z.array(z.string().max(500)).max(MAX_OPTIONS).default([]),
  multiple: z.boolean().default(true),
  separator: z.string().max(40).default("、"),
  allowCustom: z.boolean().default(false),
  defaultSelected: z.array(z.string().max(500)).max(MAX_OPTIONS).default([]),
});

export const checkboxPlaceholderSchema = placeholderBase.extend({
  type: z.literal("checkbox"),
  checkedText: z.string().max(MAX_TEXT_FIELD_LENGTH).default(""),
  uncheckedText: z.string().max(MAX_TEXT_FIELD_LENGTH).default(""),
  defaultChecked: z.boolean().default(false),
});

export const optionalLinePlaceholderSchema = placeholderBase.extend({
  type: z.literal("optional-line"),
  defaultIncluded: z.boolean().default(true),
});

export const placeholderSchema = z.discriminatedUnion("type", [
  textPlaceholderSchema,
  selectPlaceholderSchema,
  checkboxPlaceholderSchema,
  optionalLinePlaceholderSchema,
]);

export type PlaceholderType = PlaceholderDefinition["type"];
export type TextPlaceholder = z.infer<typeof textPlaceholderSchema>;
export type SelectPlaceholder = z.infer<typeof selectPlaceholderSchema>;
export type CheckboxPlaceholder = z.infer<typeof checkboxPlaceholderSchema>;
export type OptionalLinePlaceholder = z.infer<typeof optionalLinePlaceholderSchema>;
export type PlaceholderDefinition = z.infer<typeof placeholderSchema>;

const tagSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

export const promptDraftSchema = z.object({
  name: z.string().trim().min(1, "Prompt 名称不能为空").max(MAX_PROMPT_NAME_LENGTH),
  description: z.string().max(MAX_PROMPT_DESCRIPTION_LENGTH).default(""),
  tags: z.array(tagSchema).max(MAX_TAGS).default([]),
  template: z.string().max(MAX_PROMPT_TEMPLATE_LENGTH).default(""),
  placeholders: z.array(placeholderSchema).max(MAX_PLACEHOLDERS).default([]),
});

export type PromptDraft = z.infer<typeof promptDraftSchema>;

const timestamp = z.number().finite();

export const promptRecordSchema = promptDraftSchema.extend({
  id: promptId,
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type PromptRecord = z.infer<typeof promptRecordSchema>;

export const listPrompts = defineRpc({
  name: "zeonest.prompt-manager.list",
  input: z.object({}),
  output: z.object({
    prompts: z.array(promptRecordSchema).max(MAX_PROMPTS),
  }),
});

export const savePromptInputSchema = promptDraftSchema.extend({
  id: promptId.optional(),
  expectedRevision: revision.nullable().default(null),
});

export const savePromptOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("saved"),
    prompt: promptRecordSchema,
  }),
  z.object({
    status: z.literal("conflict"),
    current: promptRecordSchema.nullable(),
  }),
]);

export const savePrompt = defineRpc({
  name: "zeonest.prompt-manager.save",
  input: savePromptInputSchema,
  output: savePromptOutputSchema,
});

export const deletePromptInputSchema = z.object({
  id: promptId,
  expectedRevision: revision.nullable().optional(),
});

export const deletePromptOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("deleted"),
    id: promptId,
  }),
  z.object({
    status: z.literal("not-found"),
    id: promptId,
  }),
  z.object({
    status: z.literal("conflict"),
    current: promptRecordSchema,
  }),
]);

export const deletePrompt = defineRpc({
  name: "zeonest.prompt-manager.delete",
  input: deletePromptInputSchema,
  output: deletePromptOutputSchema,
});

export type SavePromptInput = z.input<typeof savePromptInputSchema>;
export type SavePromptResult = z.output<typeof savePromptOutputSchema>;
export type DeletePromptInput = z.input<typeof deletePromptInputSchema>;
export type DeletePromptResult = z.output<typeof deletePromptOutputSchema>;
