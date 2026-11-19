import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import type { CatalogModel, PackageUpdate, RegistryPackage } from "../shared/contracts";
import { isObject } from "../shared/config";
import { githubRepository, npmName } from "../shared/management";

const MAX_OUTPUT = 1_048_576;
const safeFlags = ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--no-tools"];
interface Invocation { executable: string; cwd: string; agentDir: string; signal: AbortSignal }

function run({ executable, cwd, agentDir, signal }: Invocation, args: string[]) {
  return new Promise<{ output: string; code: number | null }>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Pi 检查已取消。")); return; }
    const group = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1", FORCE_COLOR: "0" },
      detached: group, shell: false, stdio: ["ignore", "pipe", "ignore"],
    });
    const stop = () => {
      try { if (group && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; stop(); }, 25_000);
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", stop); };
    signal.addEventListener("abort", stop, { once: true });
    let bytes = 0;
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) stop(); else chunks.push(chunk);
    });
    child.once("error", () => { cleanup(); reject(new Error("无法启动 Pi；请检查页面设置里的可执行文件。")); });
    child.once("close", (code) => {
      cleanup();
      if (signal.aborted || timedOut || bytes > MAX_OUTPUT) { reject(new Error("Pi 检查超时、输出过大或已取消。")); return; }
      resolve({ output: Buffer.concat(chunks).toString("utf8"), code });
    });
  });
}

async function temporary<T>(callback: (dir: string) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), "zeonest-pi-inspect-"));
  try { return await callback(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function parseCatalog(output: string): CatalogModel[] {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => /^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/.test(line));
  if (header < 0) {
    if (lines.some((line) => line.startsWith("No models available."))) return [];
    throw new Error("无法读取 Pi 模型目录；请检查 Pi 版本、配置和认证。");
  }
  const models: CatalogModel[] = [];
  for (const line of lines.slice(header + 1)) {
    const match = line.match(/^(\S+)\s{2,}(\S(?:.*?\S)?)\s{2,}(\d+(?:\.\d+)?[KM]?)\s{2,}(\d+(?:\.\d+)?[KM]?)\s{2,}(yes|no)\s{2,}(yes|no)\s*$/);
    if (!match) continue;
    const [, provider, id, context, maxOutput, reasoning, images] = match;
    if (provider && id && context && maxOutput && provider.length <= 120 && id.length <= 300 && !/[\x00-\x1f\x7f]/.test(line)) models.push({ provider, id, context, maxOutput, reasoning: reasoning === "yes", images: images === "yes" });
  }
  if (!models.length) throw new Error("Pi 返回了无法识别的模型目录。");
  return models;
}

type HostInvocation = Omit<Invocation, "cwd">;
async function catalog(input: Invocation) {
  const { output, code } = await run(input, [...safeFlags, "--list-models"]);
  if (code !== 0) throw new Error("Pi 未能列出模型；请检查 Pi 版本、配置和认证。");
  return parseCatalog(output);
}
export function inspectModels(input: HostInvocation) { return temporary((cwd) => catalog({ ...input, cwd })); }

export function completedModel(output: string, provider: string, id: string) {
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isObject(event) && event.type === "message_end" && isObject(event.message)) {
        const m = event.message;
        if (m.role === "assistant" && m.provider === provider && m.model === id && (m.stopReason === "stop" || m.stopReason === "length")) return true;
      }
    } catch { /* Ignore non-event output. */ }
  }
  return false;
}
export function inspectModel(input: HostInvocation, provider: string, id: string) {
  return temporary(async (cwd) => {
    const invocation = { ...input, cwd };
    if (!/^[a-zA-Z0-9_][\w.-]*$/.test(provider) || !/^[a-zA-Z0-9_][\w./+-]*$/.test(id) || !(await catalog(invocation)).some((x) => x.provider === provider && x.id === id)) {
      throw new Error("只能测试 Pi 目录中的可用模型；请刷新目录后重试。");
    }
    const start = Date.now();
    const { code, output } = await run(invocation, [...safeFlags, "--provider", provider, "--model", id, "--print", "--mode", "json",
      "--system-prompt", "This is a connectivity test.", "--append-system-prompt", "Return only the requested test response.", "Reply with OK only."]);
    if (code !== 0 || !completedModel(output, provider, id)) throw new Error("模型未正常响应；请检查凭据、协议和服务地址。");
    return { elapsedMs: Date.now() - start };
  });
}

export function parseMcpProbe(output: string, name: string) {
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("Pi 未返回 MCP 检查结果；需支持 pi mcp list --json。"); }
  const server = isObject(value) && Array.isArray(value.servers) ? value.servers.find((entry) => isObject(entry) && entry.name === name) : undefined;
  const state = server?.state === "connected" ? "connected" as const : server?.state === "needs-auth" ? "needs-auth" as const : "failed" as const;
  const tools = state === "connected" && Array.isArray(server.tools)
    ? [...new Set<string>(server.tools.filter((x: unknown): x is string => typeof x === "string" && x.length <= 240 && !/[\x00-\x1f\x7f]/.test(x)))].slice(0, 500) : [];
  return { state, tools };
}
export function inspectMcp(input: Omit<HostInvocation, "agentDir">, name: string, config: Record<string, unknown>) {
  return temporary(async (dir) => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: config } }), { mode: 0o600 });
    // Never reuse stored OAuth tokens or the current project trust state for a probe.
    const { output } = await run({ ...input, cwd: dir, agentDir: dir }, ["mcp", "list", "--json"]);
    return parseMcpProbe(output, name);
  });
}

function metadata(value: unknown): RegistryPackage | undefined {
  if (!isObject(value) || typeof value.name !== "string" || npmName(`npm:${value.name}`) !== value.name || typeof value.version !== "string") return;
  return { name: value.name, version: value.version.slice(0, 120), description: typeof value.description === "string" ? value.description.slice(0, 500) : "" };
}
async function publicMetadata(url: string, signal: AbortSignal, accept = "application/json"): Promise<string> {
  const request = new AbortController();
  const abort = () => request.abort();
  const timer = setTimeout(abort, 8_000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const res = await fetch(url, { redirect: "error", signal: request.signal, headers: { Accept: accept, "User-Agent": "zeonest-pi-settings" } });
    if (!res.ok || !res.body) throw new Error();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > MAX_OUTPUT) throw new Error();
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
async function registry(path: string, signal: AbortSignal): Promise<unknown> {
  try { return JSON.parse(await publicMetadata(`https://registry.npmjs.org/${path}`, signal)); }
  catch { throw new Error("无法读取 npm 公共注册表；请检查包名和宿主网络后重试。"); }
}
export async function searchRegistry(query: string, signal: AbortSignal) {
  const value = await registry(`-/v1/search?${new URLSearchParams({ text: `keywords:pi-package ${query}`, size: "25" })}`, signal);
  if (!isObject(value) || !Array.isArray(value.objects)) throw new Error("npm 注册表未返回有效的搜索结果。");
  return value.objects.slice(0, 25).flatMap((x) => { const result = isObject(x) ? metadata(x.package) : undefined; return result ? [result] : []; });
}
export async function latestPackage(name: string, signal: AbortSignal) {
  if (npmName(`npm:${name}`) !== name) throw new Error("无效的 npm 包名。");
  const result = metadata(await registry(`${encodeURIComponent(name)}/latest`, signal));
  if (result?.name !== name) throw new Error("npm 注册表未返回该包的版本。");
  return result;
}

const shaPattern = /^[a-f0-9]{40}$/i;
function readGitFile(root: string, segments: string[], max = 4_096): string {
  let path = root;
  for (const [i, segment] of segments.entries()) {
    path = join(path, segment);
    const info = lstatSync(path);
    if (i < segments.length - 1 ? !info.isDirectory() : !info.isFile() || info.size > max) throw new Error("无法读取 Git 引用。");
  }
  return readFileSync(path, "utf8");
}
export function installedGitHead(root: string): string | null {
  try {
    const head = readGitFile(root, [".git", "HEAD"]).trim();
    if (shaPattern.test(head)) return head.toLowerCase();
    const ref = /^ref: (refs\/heads\/[\w./-]+)$/.exec(head)?.[1];
    if (!ref || ref.split("/").some((part) => !part || part === "." || part === "..")) return null;
    let sha: string | undefined;
    try { sha = readGitFile(root, [".git", ...ref.split("/")]).trim(); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return null;
      sha = readGitFile(root, [".git", "packed-refs"], MAX_OUTPUT).split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0];
    }
    return sha && shaPattern.test(sha) ? sha.toLowerCase() : null;
  } catch { return null; }
}

export async function inspectPackage(source: string, root: string | null, version: string | null, signal: AbortSignal): Promise<PackageUpdate> {
  const npm = npmName(source); const repository = githubRepository(source);
  if (!npm && !repository) return { state: "unavailable", installed: version, remote: null, message: "暂不支持检查本地、固定版本或非 GitHub 的 Git 来源。" };
  const installed = root ? (repository ? installedGitHead(root) : version) : null;
  if (!installed) return { state: "unavailable", installed: null, remote: null, message: "找不到已安装的版本或提交。" };
  try {
    const remote = npm ? (await latestPackage(npm, signal)).version :
      (await publicMetadata(`https://api.github.com/repos/${repository}/commits/HEAD`, signal, "application/vnd.github.sha")).trim().toLowerCase();
    if (!npm && !shaPattern.test(remote)) throw new Error();
    return { state: remote === installed ? "current" : "different", installed, remote };
  } catch {
    return { state: "failed", installed, remote: null, message: `无法读取 ${npm ? "npm" : "GitHub"} 公共元数据。` };
  }
}
