import type { Bridge } from "./bridge";

interface ActiveBridge { bridge: Bridge; busy: Set<string>; alive: () => boolean }
let active: ActiveBridge | undefined;
export function activate(value: ActiveBridge) {
  if (active) throw new Error("Pi 状态桥接已启动");
  active = value;
  return () => { if (active === value) active = undefined; };
}
export function activeBridge() {
  if (!active || !active.alive()) throw new Error("Pi 状态桥接未启用或已停止");
  return active;
}
