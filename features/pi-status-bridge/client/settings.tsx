import type { PluginSettingsScreenContribution } from "@getpaseo/plugin/client";
import { StatusBridgeSettings } from "./settings-page";

export default {
  id: "pi-status-bridge-settings",
  title: "Pi 状态桥接",
  icon: "Activity",
  Component: StatusBridgeSettings,
} satisfies PluginSettingsScreenContribution;
