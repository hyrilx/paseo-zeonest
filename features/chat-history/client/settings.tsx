import type { PluginSettingsScreenContribution } from "@getpaseo/plugin/client";
import { ChatHistorySettings } from "./settings-page";

export default {
  id: "chat-history-settings",
  title: "历史对话展开",
  icon: "History",
  Component: ChatHistorySettings,
} satisfies PluginSettingsScreenContribution;
