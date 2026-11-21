import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Workbench } from "./workbench";

let active: Workbench | undefined;

export function activeWorkbench() {
  if (!active) throw new Error("构建工作台未启用或已停止");
  return active;
}

export default function contribute(_server: PluginServerContext) {
  const home = process.env.PASEO_HOME ?? "~/.paseo";
  const root = home === "~" ? homedir() : home.startsWith("~/") ? join(homedir(), home.slice(2)) : resolve(home);
  const workbench = new Workbench(join(root, "zeonest", "build-workbench"));
  active = workbench;
  return () => {
    if (active === workbench) active = undefined;
    return workbench.close();
  };
}
