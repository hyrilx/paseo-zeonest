import type { PluginSettingsScreenContribution } from "@getpaseo/plugin/client";
import { PiSettingsPage } from "./page";

export default {
  id: "pi-settings-settings",
  title: "Pi 设置",
  icon: "Settings2",
  Component: PiSettingsPage,
} satisfies PluginSettingsScreenContribution;
