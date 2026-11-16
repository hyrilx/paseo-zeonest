import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const status = (key, text) => ({ type: "extension_ui_request", id: "unchanged", method: "setStatus", statusKey: key, ...(text === undefined ? {} : { statusText: text }) });
emit({ type: "arguments", args: process.argv.slice(2), tokenInherited: Boolean(process.env.ZEONEST_PI_STATUS_TOKEN) });
const bytes = Buffer.from(JSON.stringify(status("lens", "😀分析\n" + "long ".repeat(100))) + "\n");
const split = bytes.indexOf(Buffer.from("😀")) + 2;
process.stdout.write(bytes.subarray(0, split));
setTimeout(() => {
  process.stdout.write(bytes.subarray(split));
  emit({ type: "response", command: process.env.TEST_PI_PROBE ? "get_commands" : "get_state", success: true,
    ...(process.env.TEST_PI_LARGE_HANDSHAKE ? { data: "x".repeat(1048577) } : {}) });
}, 30);
function emitLarge(value, fragmented = false) {
  const frame = JSON.stringify(value) + "\n";
  if (fragmented) {
    for (let offset = 0; offset < frame.length; offset += 65537) process.stdout.write(frame.slice(offset, offset + 65537));
  } else process.stdout.write(frame);
}
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (line === "update") emit(status("lens", "Updated detail"));
  else if (line === "clear") emit(status("lens"));
  else if (line === "oversized") emit(status("big", "x".repeat(65537)));
  else if (line === "clear-big") emit(status("big"));
  else if (line.startsWith("large-rpc")) {
    const type = line.includes("notify") ? "extension_ui_request" : "tool_execution_end";
    emitLarge({ type, method: "notify", data: { type: "extension_ui_request", method: "setStatus", statusKey: "lens", text: "x".repeat(1048577) } }, line.includes("fragmented"));
    emit({ type: "large-rpc-done" });
  }
  else if (line === "large-status-late-key") {
    emitLarge({ type: "extension_ui_request", method: "setStatus", statusText: "x".repeat(1048577), statusKey: "lens" }, true);
    emit({ type: "large-status-done" });
  }
  else if (line.startsWith("large-status")) {
    emitLarge(status("lens", "x".repeat(1048577)), line.includes("fragmented"));
    emit({ type: "large-status-done" });
  }
  else if (line === "nested") {
    const script = `const value = { token: !!process.env.ZEONEST_PI_STATUS_TOKEN, preload: !!process.env.ZEONEST_PI_STATUS_PRELOAD, options: process.env.NODE_OPTIONS }; console.log(JSON.stringify(value)); console.log(JSON.stringify({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'nested', statusText: 'Must not bridge' }));`;
    const child = await promisify(execFile)(process.execPath, ["-e", script, "--", "--mode", "rpc"]);
    const worker = new Worker(script, { eval: true, stdout: true, argv: ["--mode", "rpc"] });
    let workerText = "";
    worker.stdout.on("data", (chunk) => { workerText += chunk.toString(); });
    await new Promise((resolve, reject) => { worker.on("error", reject); worker.on("exit", resolve); });
    emit({ type: "nested", child: JSON.parse(child.stdout.split("\n")[0]), worker: JSON.parse(workerText.split("\n")[0]) });
  }
  else if (line === "exit") { input.close(); process.exit(7); }
  else emit({ type: "echo", line });
});
