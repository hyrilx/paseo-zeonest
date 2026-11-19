import { spawnProcess } from "@getpaseo/plugin/server";
import { createServer } from "node:net";
import process from "node:process";
import { z } from "zod";
import { readHealth, readManifest } from "./http";

export const ownedIdentity = z.object({
  pid: z.number().int().positive().safe(), instanceId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/),
  startedAt: z.number().int().positive().max(8640000000000000), version: z.string().min(1).max(128),
});
export type OwnedIdentity = z.infer<typeof ownedIdentity>;
export interface LaunchedProcess { pid: number; exited(): boolean; terminate(): void }
export interface ManagedPlatform {
  now(): number;
  sleep(ms: number): Promise<void>;
  alive(pid: number): boolean;
  allocate(exclude?: number): Promise<number>;
  available(port: number): Promise<boolean>;
  probe(origin: string): Promise<OwnedIdentity | undefined>;
  spawn(command: string, port: number): Promise<LaunchedProcess>;
  signal(pid: number): void;
}
export function launcherEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, BILI_STRICT_PORT: "1", ACP_AUTO_UPDATE: "0", ACP_AUTO_RESTART_ON_UPDATE: "0" };
  for (const key of ["BILI_PARENT_PID", "BILI_LAUNCH_TOKEN", "BILI_LAUNCHER_LANE", "BILI_LAUNCHER_DIRECT", "BILI_LAUNCHER_PLUGIN"]) delete env[key];
  return env;
}
async function bind(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = listener.address();
      listener.close((error) => error ? reject(error) : address && typeof address !== "string"
        ? resolve(address.port) : reject(new Error("无法分配本机端口")));
    });
  });
}
export function createManagedPlatform(): ManagedPlatform {
  return {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
    async allocate(exclude) { for (let i = 0; i < 10; i++) { const port = await bind(0); if (port !== exclude) return port; } throw new Error("无法分配不同的可用端口"); },
    async available(port) { try { await bind(port); return true; } catch { return false; } },
    async probe(origin) {
      const controller = new AbortController();
      try {
        const manifest = await readManifest(origin, controller.signal, 500);
        if (!z.object({ ok: z.literal(true), proxy: z.literal("billion-context") }).safeParse(manifest).success) return undefined;
        const health = await readHealth(origin, controller.signal, 500);
        const parsed = ownedIdentity.extend({ ok: z.literal(true) }).safeParse(health);
        return parsed.success ? parsed.data : undefined;
      } catch { return undefined; }
    },
    spawn(command, port) {
      // On Windows a .cmd wrapper PID differs from Bili's Node PID; never guess ownership.
      if (process.platform === "win32") return Promise.reject(new Error("托管启动器目前仅支持 macOS/Linux 宿主；Windows 请使用 WSL/Linux 宿主"));
      return new Promise((resolve, reject) => {
        const child = spawnProcess(command, ["start", "--host", "127.0.0.1", "--port", String(port), "--no-auto-update"], {
          env: launcherEnvironment(process.env), detached: true, stdio: "ignore", windowsHide: true,
        });
        child.once("error", () => reject(new Error("无法执行 Bili 命令，请检查可执行文件路径及宿主 PATH")));
        child.once("spawn", () => {
          if (!child.pid) { reject(new Error("Bili 未返回进程 ID")); return; }
          child.unref();
          resolve({ pid: child.pid, exited: () => child.exitCode !== null || child.signalCode !== null, terminate: () => { child.kill("SIGTERM"); } });
        });
      });
    },
    signal(pid) { process.kill(pid, "SIGTERM"); },
  };
}
