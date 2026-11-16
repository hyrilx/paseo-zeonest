import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const metricOptions = [
  { id: "modelMs", label: "模型用时" },
  { id: "toolMs", label: "工具调用用时" },
  { id: "ttftMs", label: "首 token 平均（TTFT）" },
  { id: "averageTps", label: "输出平均速度（TPS）" },
  { id: "tools", label: "工具调用次数" },
] as const;
export const preferencesSchema = z.object({
  showCounts: z.boolean().default(true),
  visibleMetrics: z.array(z.enum(["modelMs", "toolMs", "ttftMs", "averageTps", "tools"]))
    .max(5).refine((values) => new Set(values).size === values.length, "显示指标不能重复")
    .default(metricOptions.map(({ id }) => id)),
  missingValues: z.enum(["hide", "label"]).default("hide"),
  instantWindowSeconds: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(3),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferences = defineSettings({
  id: "session-stats-preferences", scope: "host", version: 1, schema: preferencesSchema,
});
