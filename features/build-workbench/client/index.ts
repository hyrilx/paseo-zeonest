import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BuildPanel } from "./panel.tsx";

export default function contribute(client: PluginClientContext) {
  return client.addWorkspacePanel({ id: "build-workbench", title: "工作台：构建", icon: "Hammer", locations: ["workspace"], Component: BuildPanel });
}
