import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferencesSchema = z.object({
  defaultMode: z.enum(["latest", "all", "manual"]).default("latest"),
  defaultSort: z.enum(["time", "kind", "path"]).default("time"),
  descending: z.boolean().default(false),
  includeUnsuccessful: z.boolean().default(true),
  maxEntries: z.union([z.literal(1000), z.literal(5000), z.literal(20000)]).default(5000),
  previewLines: z.union([z.literal(100), z.literal(300), z.literal(1000)]).default(300),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferences = defineSettings({
  id: "file-activity-preferences", scope: "host", version: 1, schema: preferencesSchema,
});
