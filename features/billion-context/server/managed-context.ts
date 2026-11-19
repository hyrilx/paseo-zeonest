import type { ServiceManager } from "./managed-service";

let current: ServiceManager | undefined;
export function setServiceManager(manager: ServiceManager) {
  current = manager;
  return () => { if (current === manager) current = undefined; };
}
export function serviceManager(): ServiceManager {
  if (!current) throw new Error("托管服务控制器尚未就绪");
  return current;
}
