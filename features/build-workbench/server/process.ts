import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type Invocation = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; reapAfterExit?: boolean };
type Output = (stream: "stdout" | "stderr", text: string) => void;
type Exit = { code: number | null; signal: string | null; error?: string; stopped: boolean };
export type OwnedProcess = { done: Promise<Exit>; stop(): void };

// The child is the leader of its own session/process group. Hold the resource
// until both the pipes have closed and the group no longer exists.
export function launch(invocation: Invocation, output: Output): OwnedProcess {
  if (process.platform === "win32") throw new Error("当前宿主不支持 POSIX 进程组，不能运行");
  const { executable, args, cwd, env } = invocation;
  const child = spawn(executable, args, { cwd, env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  let error: string | undefined;
  let stopping = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  function signal(sig: NodeJS.Signals | 0) {
    if (!pid) return false;
    try { process.kill(-pid, sig); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
  const terminateGroup = () => {
    if (timer) return true;
    if (!signal("SIGTERM")) return false;
    timer = setTimeout(() => { signal("SIGKILL"); }, 1000);
    return true;
  };
  const stop = () => { stopping = terminateGroup() || stopping; };
  const done = new Promise<Exit>((resolve) => {
    child.once("error", (e) => { error = e.message; });
    for (const [stream, source] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      const decoder = new StringDecoder("utf8");
      source.on("data", (buf: Buffer) => output(stream, decoder.write(buf)));
      source.once("end", () => output(stream, decoder.end()));
    }
    // After the Gradle launcher exits, its compiler workers can still hold the pipes open.
    // Reap only this run's group, without changing the launcher exit status.
    if (invocation.reapAfterExit) child.once("exit", terminateGroup);
    child.once("close", (code, sig) => {
      closed = true;
      const finish = () => {
        if (signal(0)) { poll = setTimeout(finish, 100); poll.unref(); return; }
        if (timer) clearTimeout(timer);
        if (poll) clearTimeout(poll);
        resolve({ code, signal: sig, error, stopped: stopping });
      };
      finish();
    });
  });
  return { done, stop: () => { if (!closed || signal(0)) stop(); } };
}
