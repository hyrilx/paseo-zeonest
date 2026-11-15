import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { createElement } from "react";
import { PiSettingsPage } from "./page";

function Sidebar({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return createElement(SidebarRow, { icon: "Settings2", label: "Pi 设置", active: currentScreen?.screenId === "pi-settings-page", onPress: () => openScreen({ screenId: "pi-settings-page" }) });
}
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: "pi-settings-page", title: "Pi 设置", Component: PiSettingsPage }),
    client.addSidebarHeaderItem({ id: "pi-settings-sidebar", title: "Pi 设置", Component: Sidebar }),
    client.addCommandCenterItem({ id: "pi-settings-open", title: "Pi：管理配置", icon: "Settings2", context: "global", onSelect: () => client.openScreen({ screenId: "pi-settings-page" }) }),
  ];
  return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}
