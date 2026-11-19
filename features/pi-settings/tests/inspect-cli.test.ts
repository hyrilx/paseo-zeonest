import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSettingsService } from "../server/service";

const cli = process.env.ZEONEST_PI_CLI;
test("real Pi CLI tests a localhost model and lists tools from only the selected MCP server", {
  skip: !cli || process.platform === "win32" ? "Set ZEONEST_PI_CLI on a POSIX system to run the isolated localhost fixture" : false,
  timeout: 45_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-inspect-contract-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const sent: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = ""; for await (const data of req) body += String(data);
    sent.push(JSON.parse(body));
    const event = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "tiny", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
    res.writeHead(200, { "Content-Type": "text/event-stream" }).end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  const service = new PiSettingsService({ agentDir, home: root, workspaceDirectory: async () => root });
  t.after(() => { service.dispose(); server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const wrapper = join(root, "pi-wrapper");
  writeFileSync(wrapper, `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: "inherit", env: { PATH: process.env.PATH, HOME: ${JSON.stringify(root)}, TMPDIR: ${JSON.stringify(root)}, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" } });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
  const mcp = join(root, "mcp.cjs");
  writeFileSync(mcp, `const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const result = method === "initialize" ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
    : method === "tools/list" ? { tools: [{ name: "fixture_status", description: "fixture", inputSchema: { type: "object" } }] } : null;
  const reply = result ? { id, result } : { id, error: { code: -32601, message: "Method not found" } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...reply }) + "\\n");
});\n`);
  writeFileSync(join(agentDir, "zeonest-pi-settings.json"), JSON.stringify({ piExecutable: wrapper }));
  writeFileSync(join(agentDir, "SYSTEM.md"), "DO_NOT_SEND_SAVED_SYSTEM");
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "DO_NOT_SEND_SAVED_APPEND");
  writeFileSync(join(agentDir, "AGENTS.md"), "DO_NOT_SEND_SAVED_CONTEXT");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "mock-key", models: [{ id: "tiny", contextWindow: 4096, maxTokens: 32 }],
  } } }));
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    chosen: { command: process.execPath, args: [mcp] }, disabled: { enabled: false, command: process.execPath, args: [mcp] }, unrelated: { command: "/does/not/exist" },
  } }));
  const snapshot = await service.snapshot({});
  const revision = (kind: string) => snapshot.documents.find((d) => d.kind === kind)!.revision;
  const input = { confirmed: true as const, revision: revision("models"), preferencesRevision: revision("preferences") };
  await assert.rejects(service.listModels({ ...input, revision: "stale" }));
  const models = await service.listModels(input);
  assert.ok(models.some((m) => m.provider === "fixture" && m.id === "tiny"));
  assert.equal(sent.length, 0);
  assert.ok((await service.testModel({ ...input, provider: "fixture", id: "tiny" })).elapsedMs >= 0);
  assert.equal(sent.length, 1);
  const body = JSON.stringify(sent[0]); assert.match(body, /Reply with OK only\./); assert.doesNotMatch(body, /DO_NOT_SEND_SAVED_/);
  const mcpInput = { ...input, revision: revision("mcp") };
  assert.deepEqual(await service.testMcp({ ...mcpInput, name: "chosen" }), { state: "connected", tools: ["fixture_status"] });
  await assert.rejects(service.testMcp({ ...mcpInput, name: "disabled" }), /只可检查已保存并启用/);
});
