import { homedir } from "node:os";
import path from "node:path";
import { execCommand, spawnProcess } from "@getpaseo/plugin/server";
import { errorMessage } from "../shared/lifetime";

interface Options {
  env?: NodeJS.ProcessEnv;
  parentPid?: number;
  exec?: typeof execCommand;
  spawn?: typeof spawnProcess;
}

/** CLI ownership stays separate from feature cleanup: self-reload must not await or kill it. */
export function createPluginReloader(options: Options = {}) {
  const env = { ...(options.env ?? process.env) };
  const rawHome = env.PASEO_HOME ?? "~/.paseo";
  const home = path.resolve(rawHome === "~" ? homedir()
    : rawHome.startsWith("~/") ? path.join(homedir(), rawHome.slice(2)) : rawHome);
  env.PASEO_HOME = home;
  delete env.PASEO_HOST;
  const parentPid = options.parentPid ?? process.ppid;
  const exec = options.exec ?? execCommand;
  const spawn = options.spawn ?? spawnProcess;
  const controller = new AbortController();
  let pending: Promise<{ error: string | null }> | undefined;

  async function run() {
    try {
      // --home ignores saved/remote CLI targets. Verify the live worker before any mutation.
      const { stdout } = await exec("paseo", ["daemon", "status", "--home", home, "--json"], {
        env, timeout: 10_000, maxBuffer: 256 * 1024, signal: controller.signal,
      });
      const status: unknown = JSON.parse(stdout);
      if (!status || typeof status !== "object" || !("workerPid" in status)
        || status.workerPid !== parentPid) {
        throw new Error("无法确认 CLI 指向当前插件宿主，已取消重载。请在 Paseo 插件菜单中重新加载。");
      }
      if (controller.signal.aborted) throw new Error("插件正在停止，已取消重载。");

      return await new Promise<{ error: string | null }>((resolve) => {
        // Ignore stdout so CLI success output cannot hit a closed pipe after plugin teardown.
        const child = spawn("paseo", ["plugin", "reload", "zeonest", "--home", home, "--json"], {
          env, detached: true, stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        let settled = false;
        const finish = (error: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({ error });
        };
        const timeout = setTimeout(() => {
          child.kill();
          finish("CLI 执行超时，重载结果尚未确认。请查看 Paseo 插件状态和日志。");
        }, 60_000);
        timeout.unref();
        child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
        child.once("error", (error) => finish(errorMessage(error)));
        child.once("close", (code, signal) => finish(code === 0 ? null
          : stderr.trim() || `Paseo CLI 已退出（${signal ?? code}），请查看插件状态和日志。`));
        child.unref();
      });
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  return {
    reload() {
      if (controller.signal.aborted) return Promise.resolve({ error: "插件正在停止，无法发起重载。" });
      // Multiple clients share the same command while it is running.
      pending ??= run().finally(() => { pending = undefined; });
      return pending;
    },
    dispose() {
      // Cancel preflight only. Awaiting or killing the detached reload would deadlock teardown.
      controller.abort();
    },
  };
}
