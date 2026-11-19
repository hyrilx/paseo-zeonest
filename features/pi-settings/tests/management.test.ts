import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completedModel, inspectPackage, installedGitHead, parseCatalog, parseMcpProbe } from "../server/inspect";
import { validateConfig } from "../shared/config";
import { canCheckPackage, codemodeToolRules, customModels, mergeMcpImport, npmName, resolveCodemode } from "../shared/management";

test("parses a Pi catalog without forwarding warnings or credentials", () => {
  assert.deepEqual(parseCatalog("unrelated\nprovider   model         context  max-out  thinking  images\nlocal      model with space   1.2M     8K       yes       no\nsecret warning\n"), [
    { provider: "local", id: "model with space", context: "1.2M", maxOutput: "8K", reasoning: true, images: false },
  ]);
  assert.deepEqual(parseCatalog("No models available. Use /login."), []);
  assert.throws(() => parseCatalog("secret"), /无法读取 Pi 模型目录/);
});

test("probes only recognize the requested model and redact MCP diagnostics", () => {
  const event = (stopReason: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "test", model: "small", stopReason } });
  assert.equal(completedModel(event("stop"), "test", "small"), true);
  assert.equal(completedModel(event("error"), "test", "small"), false);
  assert.equal(completedModel(event("stop"), "test", "large"), false);
  assert.deepEqual(parseMcpProbe(JSON.stringify({ servers: [
    { name: "elsewhere", state: "connected", tools: ["other"] },
    { name: "chosen", state: "connected", tools: ["read", "read", 3, "\u001b"], error: "secret" },
  ] }), "chosen"), { state: "connected", tools: ["read"] });
  assert.deepEqual(parseMcpProbe('{"servers":[{"name":"chosen","state":"needs-auth"}]}', "chosen"), { state: "needs-auth", tools: [] });
});

test("imports servers without replacing existing entries or unrelated settings", () => {
  const original = '{"mcpServers":{"one":{"command":"one"}},"autoEnableCodemode":false}';
  const merged = mergeMcpImport(original, '{"mcpServers":{"two":{"url":"https://example.com/mcp"}}}');
  assert.deepEqual(JSON.parse(merged), { mcpServers: { one: { command: "one" }, two: { url: "https://example.com/mcp" } }, autoEnableCodemode: false });
  assert.throws(() => mergeMcpImport(original, '{"mcpServers":{"one":{"command":"two"}}}'), /同名/);
  assert.throws(() => mergeMcpImport(original, '{"mcpServers":{"__proto__":{}}}'), /不合法/);
});

test("validates tool exposures and structured MCP fields before a write", () => {
  const validate = (entry: Record<string, unknown>) => validateConfig("mcp", JSON.stringify({ mcpServers: { demo: { url: "https://example.test/mcp", ...entry } } }), false);
  assert.doesNotThrow(() => validate({ timeout: 1.5, exposure: "hidden", toolExposure: { "read*": "direct" }, oauth: { clientId: "fixture", clientRegistration: "dcr", scope: "read" } }));
  assert.throws(() => validate({ toolExposure: { read: "inherit" } }), /toolExposure/);
  assert.throws(() => validate({ timeout: 0 }), /timeout/);
  assert.throws(() => validate({ oauth: { clientRegistration: "unknown" } }), /oauth.clientRegistration/);
});

test("npm metadata excludes pinned packages, git, paths and aliases", () => {
  assert.equal(npmName("npm:@scope/pi-example"), "@scope/pi-example");
  for (const spec of ["npm:test@latest", "npm:test@1.2.3", "npm:test/other", "./test", "https://example.test/test", "npm:../test"]) assert.equal(npmName(spec), undefined);
  assert.deepEqual(customModels({ providers: { local: { models: [{ id: "foo", reasoning: true, input: ["text", "image"], maxTokens: 123 }] } } }), [{ provider: "local", id: "foo", reasoning: true, images: true, context: "", maxOutput: "123" }]);
});

test("preserves unrelated default tool rules and explicit empty selection when changing Code mode", () => {
  assert.deepEqual(codemodeToolRules(["read", "-codemode", "+mcp"], true), ["read", "+mcp", "+codemode"]);
  assert.deepEqual(codemodeToolRules([], true), ["codemode"]);
  assert.deepEqual(codemodeToolRules(["codemode"], false), []);
  assert.equal(codemodeToolRules(["+codemode"], false), undefined);
  assert.equal(resolveCodemode(["+codemode"], ["-codemode"]), false);
  assert.equal(resolveCodemode(["+codemode"], ["read"]), false);
  assert.equal(resolveCodemode(["+codemode"], []), true);
  assert.doesNotThrow(() => validateConfig("settings", '{"codemode":{"mode":"only","inlineBudget":0}}', false));
  assert.throws(() => validateConfig("settings", '{"codemode":{"inlineBudget":-1}}', false), /inlineBudget/);
});

test("compares unpinned package metadata only via fixed public endpoints", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "zeonest-git-") );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = "a".repeat(40); const remote = "b".repeat(40);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "packed-refs"), `${local} refs/heads/main\n`);
  assert.equal(installedGitHead(root), local);
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => new Response(url.startsWith("https://api.github.com/") ? remote : JSON.stringify({ name: "pi-demo", version: "2.0.0" })));
  const signal = new AbortController().signal;
  assert.deepEqual(await inspectPackage("git:github.com/owner/pi-demo.git", root, null, signal), { state: "different", installed: local, remote });
  assert.deepEqual(await inspectPackage("npm:pi-demo", root, "2.0.0", signal), { state: "current", installed: "2.0.0", remote: "2.0.0" });
  for (const source of ["git:github.com/owner/pi-demo@main", "git:https://elsewhere.test/owner/pi-demo", "npm:pi-demo@latest"]) assert.equal(canCheckPackage(source), false);
  assert.deepEqual(fetch.mock.calls.map((call) => call.arguments[0]), ["https://api.github.com/repos/owner/pi-demo/commits/HEAD", "https://registry.npmjs.org/pi-demo/latest"]);
});
