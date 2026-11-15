import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ChatHistoryRenderer } from "./history";
import { chatHistorySchema, historyTransformer } from "./transform";

export default function contribute(client: PluginClientContext) {
  const removeRenderer = client.addTimelineRenderer({
    kind: "chat-history",
    version: 1,
    schema: chatHistorySchema,
    Component: ChatHistoryRenderer,
  });
  let removeTransformer: () => void;
  try {
    removeTransformer = client.addTimelineTransformer(historyTransformer);
  } catch (error) {
    removeRenderer();
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    try { removeTransformer(); }
    finally { removeRenderer(); }
  };
}
