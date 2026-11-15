import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferencesSchema = z.object({
  defaultExpanded: z.boolean().default(false),
  previewLength: z.number().int().min(0).max(20000).default(1800),
  pageSize: z.number().int().min(10).max(200).default(40),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = preferencesSchema.parse({});
export const preferences = defineSettings({
  id: "chat-history-preferences",
  scope: "host",
  version: 1,
  schema: preferencesSchema,
});
