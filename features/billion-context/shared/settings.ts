import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Origins only: no credentials, paths, query strings or fragments travel to RPCs/navigation.
export function validOrigin(value: string): boolean {
  const match = /^https?:\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::([0-9]{1,5}))?$/.exec(value);
  return !!match && (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535))
    && z.url().safeParse(value).success;
}
const origin = z.string().trim().transform((value) => value.replace(/\/+$/, ""))
  .refine(validOrigin, "填写 HTTP(S) 源地址，例如 http://127.0.0.1:8787，不含路径或凭据");
export const preferencesSchema = z.object({
  serverOrigin: origin.default("http://127.0.0.1:8787"),
  browserOrigin: z.union([z.literal(""), origin]).default(""),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferences = defineSettings({
  id: "billion-context-preferences", scope: "host", version: 1, schema: preferencesSchema,
});
