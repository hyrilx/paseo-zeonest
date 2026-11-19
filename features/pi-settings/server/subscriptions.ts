import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import type { SubscriptionAuthState, SubscriptionCatalog, subscriptionAction } from "../shared/contracts";
import { isObject } from "../shared/config";
import { subscriptionWorker } from "./subscription-worker";
import type { z } from "zod";

type Host = { executable: string; agentDir: string; signal: AbortSignal };
type CatalogRequest = { patterns: string[]; refresh?: string };
type AuthRequest = { provider: string; action: "login" | "logout" };
const unsupported = "订阅管理需要 npm 发行版的 Pi 1.5.2（宿主 PATH 中需有 Node.js）。也可以在宿主使用 pi auth login/logout 和 pi update --models。";
const failures = { catalog: "无法读取订阅目录。请检查宿主 Pi 或稍后重试。", auth: "Pi 未完成订阅登录或登出。请重试，或在宿主使用 pi auth。" };

function boundedFile(path: string, size: number) {
  if (!statSync(path).isFile()) throw new Error(unsupported);
  const fd = openSync(path, "r");
  try { const out = Buffer.alloc(size); return out.toString("utf8", 0, readSync(fd, out, 0, size, 0)); }
  finally { closeSync(fd); }
}
export function subscriptionSdk(executable: string, path = process.env.PATH ?? ""): string {
  try {
    const paths = isAbsolute(executable) ? [executable] : executable.includes("/") || executable.includes("\\") ? [] : path.split(delimiter).filter(isAbsolute).map((base) => resolve(base, executable));
    const found = paths.find((item) => { try { accessSync(item, constants.X_OK); return statSync(item).isFile(); } catch { return false; } });
    if (!found) throw new Error(unsupported);
    const file = realpathSync(found);
    const shim = boundedFile(file, 2048).match(/^#![^\n]*\n# aube-bin-shim v2 target=([^\r\n]+)/);
    const cli = shim?.[1] ? realpathSync(resolve(dirname(file), shim[1])) : file;
    for (const root of [dirname(dirname(cli)), dirname(dirname(dirname(cli)))]) {
      const manifestPath = resolve(root, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(boundedFile(manifestPath, 16384));
      if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "1.5.2" || manifest.exports?.["."]?.import !== "./dist/index.js") continue;
      if (typeof manifest.bin?.pi !== "string" || ![resolve(root, manifest.bin.pi), resolve(root, "dist/cli.js")].includes(cli)) continue;
      return realpathSync(resolve(root, "dist/index.js"));
    }
  } catch { /* not a supported Pi installation */ }
  throw new Error(unsupported);
}

function terminate(child: ChildProcess) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch { /* already exited */ }
}
function invoke<T>(host: Host, request: CatalogRequest | AuthRequest, receive?: (message: Record<string, unknown>, child: ChildProcess) => void): Promise<T> {
  const entry = subscriptionSdk(host.executable);
  const auth = "action" in request;
  if (host.signal.aborted) throw new Error("订阅操作已取消。");
  const cwd = mkdtempSync(resolve(tmpdir(), "zeonest-pi-subscription-"));
  return new Promise<T>((resolveValue, reject) => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: host.agentDir, NODE_OPTIONS: "" };
    let child: ChildProcess;
    try {
      child = spawn("node", ["--input-type=module", "--eval", subscriptionWorker], {
        cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch { rmSync(cwd, { recursive: true, force: true }); reject(new Error(unsupported)); return; }
    let settled = false;
    const failure = auth ? failures.auth : failures.catalog;
    const abort = () => {
      if (child.connected) child.send({ type: "cancel" }, () => {});
      clearTimeout(timer);
      timer = setTimeout(() => settle(false), 750);
    };
    let timer = setTimeout(abort, auth && request.action === "login" ? 5 * 60_000 : 24_000);
    timer.unref();
    const settle = (ok: boolean, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); host.signal.removeEventListener("abort", abort);
      terminate(child);
      rmSync(cwd, { recursive: true, force: true });
      if (ok) resolveValue(value as T);
      else reject(new Error(failure));
    };
    host.signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => settle(false));
    child.on("exit", () => settle(false));
    child.on("message", (message) => {
      if (settled || !isObject(message)) return;
      if (message.type === "done") settle(true, message.value as T);
      else if (message.type === "failed") settle(false);
      else receive?.(message, child);
    });
    child.send({ type: "start", entry, agentDir: host.agentDir, request }, (error) => { if (error) settle(false); });
  });
}

export function loadSubscriptions(host: Host, request: CatalogRequest) { return invoke<SubscriptionCatalog>(host, request); }

const bounded = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit).replace(/[\x00-\x1f\x7f]/g, " ") : "";
function loginUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export class SubscriptionLogin {
  readonly token = randomUUID();
  readonly signal = new AbortController();
  state: SubscriptionAuthState = { status: "pending" };
  private child?: ChildProcess;
  async run(host: Host, request: AuthRequest) {
    const abort = () => this.signal.abort();
    if (host.signal.aborted) abort();
    host.signal.addEventListener("abort", abort, { once: true });
    try {
      await invoke<null>({ ...host, signal: this.signal.signal }, request, (data, child) => this.receive(data, child));
      this.state = { status: this.signal.signal.aborted ? "cancelled" : "success" };
    } catch { this.state = { status: this.signal.signal.aborted ? "cancelled" : "failed" }; }
    finally { host.signal.removeEventListener("abort", abort); this.child = undefined; }
  }
  private receive(data: Record<string, unknown>, child: ChildProcess) {
    if (this.signal.signal.aborted) return;
    if (data.type === "link") {
      this.state = { ...this.state, url: loginUrl(data.url), code: bounded(data.code, 32) || undefined };
    } else if (data.type === "clear" && this.state.prompt?.id === data.id) {
      this.state = { ...this.state, prompt: undefined };
    } else if (data.type === "prompt" && typeof data.id === "number" && (data.kind === "text" || data.kind === "secret" || data.kind === "manual_code" || data.kind === "select")) {
      this.child = child;
      const options = Array.isArray(data.options) ? data.options.slice(0, 40).filter(isObject).map((opt) => ({ value: bounded(opt.value, 200), label: bounded(opt.label, 200) })) : undefined;
      this.state = { ...this.state, prompt: { id: data.id, kind: data.kind, message: bounded(data.message, 400), options } };
    }
  }
  act({ action, id, value }: z.infer<typeof subscriptionAction.input>): SubscriptionAuthState {
    if (this.state.status !== "pending" || action === "status") return this.state;
    if (action === "cancel") {
      this.signal.abort(); this.state = { status: "cancelled" };
      return this.state;
    }
    const prompt = this.state.prompt;
    if (!prompt || prompt.id !== id || !value || !this.child?.connected) throw new Error("这一步登录已结束，或还未收到输入请求。");
    if (prompt.kind === "select" && !prompt.options?.some((option) => option.value === value)) throw new Error("请选择登录方式。");
    this.child.send({ type: "reply", id, value }, () => {});
    this.state = { ...this.state, prompt: undefined };
    return this.state;
  }
}
