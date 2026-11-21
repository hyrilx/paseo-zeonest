import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferencesSchema = z.object({
  defaultView: z.enum(["edit", "preview"]).default("edit"),
  editorSize: z.enum(["small", "standard", "large"]).default("standard"),
  showToolbar: z.boolean().default(true),
});

export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences = preferencesSchema.parse({});
export const preferences = defineSettings({
  id: "conversation-notes-preferences",
  scope: "host",
  version: 1,
  schema: preferencesSchema,
});
