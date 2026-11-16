import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ChatHistoryRenderer } from "./history";
import { chatHistorySchema, createHistoryTransformer, historyTransformer } from "./transform";
import { observeHistory } from "./backfill";

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
  const stopObservation = observeHistory(client.paseo, (records) => {
    if (!active) return;
    // Removing and registering publishes a new native transformer identity, which
    // makes Paseo reproject even an unchanged optimistic user-message object.
    try {
      removeTransformer();
      removeTransformer = () => {};
      removeTransformer = client.addTimelineTransformer(createHistoryTransformer(records));
    } catch {
      console.warn("[chat-history] Could not register backfilled history; using text-only rendering.");
      try { removeTransformer = client.addTimelineTransformer(historyTransformer); }
      catch { console.error("[chat-history] Timeline registration unavailable; leaving messages native."); }
    }
  });
  return () => {
    if (!active) return;
    active = false;
    const released = stopObservation();
    try { removeTransformer(); }
    finally { removeRenderer(); }
    return released;
  };
}
