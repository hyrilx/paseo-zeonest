import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";
import { splitHistoryMessage } from "./parse";

export const chatHistorySchema = z.object({
  histories: z.array(z.string()).min(1),
  body: z.string(),
});

export type HistoryUserMessage = Parameters<PluginTimelineTransformerContribution<"user_message">["transform"]>[0]["item"];

export interface HistoryRecord {
  agentId: string;
  messageId?: string;
  clientMessageId?: string;
  histories: readonly string[] | null;
}

function compatible(a: HistoryRecord, b: HistoryRecord): boolean {
  return a === b || a.agentId === b.agentId
    && !(a.messageId && b.messageId && a.messageId !== b.messageId)
    && !(a.clientMessageId && b.clientMessageId && a.clientMessageId !== b.clientMessageId)
    && JSON.stringify(a.histories) === JSON.stringify(b.histories);
}

// Each registration owns a private snapshot. Mutating an async lookup behind an
// existing transformer would leave Paseo's source-reference projection cache stale.
export function createHistoryTransformer(records: readonly HistoryRecord[] = []) {
  const lookup = new Map<string, HistoryRecord | null>();
  for (const source of records) {
    const record: HistoryRecord = { ...source, histories: source.histories ? [...source.histories] : null };
    for (const key of [record.messageId && `message:${record.messageId}`, record.clientMessageId && `client:${record.clientMessageId}`]) {
      if (!key) continue;
      if (!lookup.has(key)) { lookup.set(key, record); continue; }
      const previous = lookup.get(key);
      lookup.set(key, previous && compatible(previous, record) ? {
        ...record,
        messageId: record.messageId ?? previous.messageId,
        clientMessageId: record.clientMessageId ?? previous.clientMessageId,
      } : null);
    }
  }
  return {
    id: "chat-history",
    query: { itemType: "user_message" },
    transform({ item }) {
      let data = splitHistoryMessage(item.text);
      if (!data) {
        const matches = [item.messageId && `message:${item.messageId}`, item.clientMessageId && `client:${item.clientMessageId}`]
          .filter((key): key is string => !!key && lookup.has(key)).map((key) => lookup.get(key)!);
        const record = matches[0];
        if (!record?.histories || matches.some((match) => !match || !compatible(record, match))) return undefined;
        if (item.messageId && record.messageId && item.messageId !== record.messageId) return undefined;
        if (item.clientMessageId && record.clientMessageId && item.clientMessageId !== record.clientMessageId) return undefined;
        data = { histories: [...record.histories], body: item.text };
      }
      return { items: [{ type: "plugin", kind: "chat-history", version: 1, data: { ...data } }] };
    },
  } satisfies PluginTimelineTransformerContribution<"user_message">;
}

export const historyTransformer = createHistoryTransformer();
