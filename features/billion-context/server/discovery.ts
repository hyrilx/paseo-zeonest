import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { validOrigin } from "../shared/settings";

// The history pool is separate from the maximum number of choices shown to a user.
export const MAX_CANDIDATES = 256;
const LOG_BYTES = 524288;

// Discovery never trusts a recorded remote address with a provider conversation ID.
export function localOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i.test(value) || !validOrigin(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return;
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url.origin;
  } catch { return; }
}
export function inlineOrigins(text: string): string[] {
  const matches = text.matchAll(/\[inline\] web UI listening on (http:\/\/127\.0\.0\.1:[0-9]{1,5}) \(loopback only\)/g);
  return [...matches].map((match) => localOrigin(match[1])).filter((value): value is string => !!value).reverse();
}
async function readBounded(file: string, limit: number, tail = false): Promise<string> {
  // lstat also rejects symlinks on platforms without O_NOFOLLOW.
  if (!(await lstat(file)).isFile()) return "";
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (!tail && info.size > limit)) return "";
    const length = Math.min(info.size, limit);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, tail ? info.size - length : 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // A partial first line cannot be a trusted startup record.
    if (tail && info.size > length) return text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
    return text;
  } finally { await handle.close(); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function fromRecord(value: unknown, isAlive: (pid: number) => boolean): string | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.portReleasedAt != null || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || !isAlive(record.pid as number)) return;
  return localOrigin(record.origin);
}
function recordOrigin(text: string, isAlive: (pid: number) => boolean): string | undefined {
  try { return fromRecord(JSON.parse(text), isAlive); }
  catch {
    // The legacy proxy-origin file contains just an origin; it still needs an HTTP probe.
    return localOrigin(text.trim());
  }
}
function legacyOrigins(text: string, isAlive: (pid: number) => boolean): (string | undefined)[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("instances" in value) || !Array.isArray(value.instances)) return [];
    return value.instances.slice(0, 64).map((record: unknown) => fromRecord(record, isAlive));
  } catch { return []; }
}
export async function discoverOrigins(
  signal: AbortSignal, directory = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "billion-context"),
  isAlive: (pid: number) => boolean = alive,
): Promise<string[]> {
  const check = () => { if (signal.aborted) throw new Error("Billion Context 已停止"); };
  check();
  const safeRead = async (file: string, limit: number, tail = false) => {
    check();
    try { return await readBounded(file, limit, tail); } catch { return ""; }
  };
  const instancesDirectory = join(directory, "instances");
  const [log, proxy, legacy, names] = await Promise.all([
    safeRead(join(directory, "bili.log"), LOG_BYTES, true),
    safeRead(join(directory, "proxy-origin"), 32768),
    safeRead(join(directory, "instances.json"), 32768),
    lstat(instancesDirectory).then((info) => info.isDirectory() ? readdir(instancesDirectory) : []).catch(() => [] as string[]),
  ]);
  check();
  const records: string[] = [];
  const files = names.filter((name) => name.endsWith(".json")).sort().slice(0, 64);
  // Bound simultaneous file descriptors even in a large instance registry.
  for (let offset = 0; offset < files.length; offset += 8) {
    records.push(...await Promise.all(files.slice(offset, offset + 8).map((name) => safeRead(join(directory, "instances", name), 32768))));
  }
  check();
  const candidates = [recordOrigin(proxy, isAlive), ...records.map((text) => recordOrigin(text, isAlive)), ...legacyOrigins(legacy, isAlive), ...inlineOrigins(log)];
  return [...new Set(candidates.filter((value): value is string => !!value))].slice(0, MAX_CANDIDATES);
}
