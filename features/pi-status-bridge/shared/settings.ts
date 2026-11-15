import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const actionSchema = z.object({
  key: z.string().min(1).max(256),
  command: z.string().max(2048).regex(/^\/[a-zA-Z0-9_.:-]+(?: [^\r\n\u0000]*)?$/, "填写单行 /插件命令，可带固定参数"),
});
export const preferencesSchema = z.object({
  hiddenKeys: z.array(z.string().min(1).max(256)).max(128).default([]),
  actions: z.array(actionSchema).max(128).default([]),
}).superRefine((value, context) => {
  if (new Set(value.actions.map((action) => action.key)).size !== value.actions.length) {
    context.addIssue({ code: "custom", message: "同一状态 key 只能配置一个展开命令" });
  }
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferences = defineSettings({
  id: "pi-status-bridge-preferences", scope: "host", version: 2, schema: preferencesSchema,
  migrate: (values, fromVersion) => {
    if (fromVersion !== 1) throw new Error("不支持的 Pi 状态桥接配置版本");
    // Strip the removed preview-length field while preserving hidden keys/actions.
    return preferencesSchema.parse(values);
  },
});
