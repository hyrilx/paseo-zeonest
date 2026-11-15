import type { PluginServerContext } from "@getpaseo/plugin/server";
import { activate } from "./activation";

export default function contribute(_server: PluginServerContext) {
  return activate();
}
