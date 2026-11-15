import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";
import { splitHistoryMessage } from "./parse";

export const chatHistorySchema = z.object({
  histories: z.array(z.string()).min(1),
  body: z.string(),
});

export const historyTransformer = {
  id: "chat-history",
  query: { itemType: "user_message" },
  transform({ item }) {
    const data = splitHistoryMessage(item.text);
    if (!data) return undefined;
    return { items: [{ type: "plugin", kind: "chat-history", version: 1, data: { ...data } }] };
  },
} satisfies PluginTimelineTransformerContribution<"user_message">;
