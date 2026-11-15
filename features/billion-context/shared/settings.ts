import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Origins only: no credentials, paths, query strings or fragments travel to RPCs/navigation.
export function validOrigin(value: string): boolean {
  const match = /^https?:\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::([0-9]{1,5}))?$/.exec(value);
  return !!match && (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535))
    && z.url().safeParse(value).success;
}
const normalizedOrigin = z.string().trim().transform((value) => value.replace(/\/+$/, ""));
const origin = normalizedOrigin.refine((value) => !value || validOrigin(value),
  "填写 HTTP(S) 源地址，例如 http://127.0.0.1:8787，不含路径或凭据");
const browserOrigin = normalizedOrigin.refine((value) => !value || validOrigin(value)
  || (value.endsWith(":{port}") && validOrigin(value.replace("{port}", "1234"))),
  "填写 HTTP(S) 源地址；端口可用 {port}，例如 http://my-host:{port}，不含路径或凭据");
export const preferencesSchema = z.object({
  serverOrigin: origin.default(""),
  browserOrigin: browserOrigin.default(""),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferences = defineSettings({
  id: "billion-context-preferences", scope: "host", version: 1, schema: preferencesSchema,
});
