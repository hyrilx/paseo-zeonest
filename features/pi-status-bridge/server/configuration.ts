import type { Preferences } from "../shared/settings";

let reader: (() => Promise<Preferences>) | undefined;
export function setPreferencesReader(value: () => Promise<Preferences>) {
  reader = value;
  return () => { if (reader === value) reader = undefined; };
}
export function readPreferences(): Promise<Preferences> {
  if (!reader) return Promise.reject(new Error("Pi 状态桥接配置服务尚未就绪"));
  return reader();
}
