import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, packageIdentity, packagePath } from "../server/discovery";
import { effectiveMcp, parseObject, resourceLoading, resourceRules, setModelInvocation, setProperty, validateConfig } from "../shared/config";

test("JSONC property edits retain unrelated fields, comments, CRLF and unknown provider options", () => {
  const initial = '{\r\n\t// retained\r\n\t"custom": {"future": 7},\r\n\t"defaultModel": "old",\r\n}\r\n';
  const next = setProperty(initial, ["defaultModel"], "new");
  assert.match(next, /\/\/ retained/); assert.match(next, /\r\n\t/); assert.deepEqual(parseObject(next).custom, { future: 7 });
  assert.equal(parseObject(next).defaultModel, "new");
  assert.throws(() => setProperty("{broken", ["x"], 1), /有效/);
});

test("resource rules do not alter other settings; skill automatic invocation is not skill unloading", () => {
  const next = resourceRules('{"skills":["somewhere","-/old"],"unknown":true}', "skill", "/skill/SKILL.md", false);
  assert.deepEqual(parseObject(next).skills, ["somewhere", "-/old", "-/skill/SKILL.md"]);
  const skill = '---\r\nname: demo\r\ndescription: Demo\r\n---\r\nUse it\r\n';
  const disabled = setModelInvocation(skill, false); assert.match(disabled, /disable-model-invocation: true\r\n/); assert.match(disabled, /Use it\r\n$/);
  const enabled = setModelInvocation(disabled, true); assert.match(enabled, /disable-model-invocation: false/);
  assert.throws(() => setModelInvocation("no frontmatter", false), /frontmatter/);
});

test("resource switches edit package filters, use project deltas, and never re-enable an entire disabled group", () => {
  const resource = { kind: "skill" as const, path: "/global/npm/node_modules/pkg/skills/one/SKILL.md", scope: "global" as const, packageSource: "npm:pkg", packageRoot: "/global/npm/node_modules/pkg" };
  const global = resourceLoading('{"packages":[{"source":"npm:pkg","skills":[]}]}', resource, true, false);
  assert.deepEqual((parseObject(global).packages as any[])[0].skills, ["!**/*", "+skills/one/SKILL.md"]);
  const project = resourceLoading("{}", resource, false, true);
  assert.deepEqual(parseObject(project).packages, [{ source: "npm:pkg", autoload: false, skills: ["-skills/one/SKILL.md"] }]);
  const standalone = resourceLoading("{}", { kind: "skill", scope: "global", path: "/global/skills/one/SKILL.md" }, false, true);
  assert.deepEqual(parseObject(standalone).skills, ["/global/skills/one/SKILL.md", "-/global/skills/one/SKILL.md"]);
});

test("MCP project overrides preserve global transport/secrets and only supported override fields", () => {
  const merged = effectiveMcp({ mcpServers: { api: { url: "https://example.com/mcp", headers: { Authorization: "${TOKEN}" }, exposure: "direct" } } },
    { mcpServers: { api: { enabled: false, headers: { Authorization: "must-not-override" } } } });
  assert.deepEqual(merged.api, { url: "https://example.com/mcp", headers: { Authorization: "${TOKEN}" }, exposure: "direct", enabled: false });
  const replaced = effectiveMcp({ mcpServers: { api: { url: "https://example.com/mcp", headers: { A: "B" } } } }, { mcpServers: { api: { command: "npx", args: [] } } });
  assert.deepEqual(replaced.api, { command: "npx", args: [] });
});

test("native format checks reject unsupported MCP transport and model/project mismatches", () => {
  assert.throws(() => validateConfig("mcp", '{"mcpServers":{"s":{"type":"sse","url":"https://example.com"}}}', false), /SSE/);
  assert.throws(() => validateConfig("mcp", '{"mcpServers":{"a-b":{"command":"a"},"a_b":{"command":"b"}}}', false), /重复/);
  assert.throws(() => validateConfig("mcp", '{"mcpServers":{"s":{"enabled":false}}}', false), /command/);
  assert.throws(() => validateConfig("mcp", '{/*comment*/"mcpServers":{}}', false), /标准 JSON/);
  assert.throws(() => validateConfig("settings", '{"skills":"not-array"}', false), /字符串数组/);
  assert.throws(() => validateConfig("models", '{"providers":{}}', true), /全局/);
  assert.throws(() => validateConfig("models", '{"providers":{"p":{"models":[{"id":""}]}}}', false), /非空 id/);
  assert.deepEqual(validateConfig("mcp", '{"mcpServers":{"s":{"enabled":false}}}', true), { mcpServers: { s: { enabled: false } } });
});

test("npm and git package identity ignores versions while local paths resolve per scope", () => {
  assert.equal(packageIdentity("npm:@scope/tools@1", "/a", "/home"), packageIdentity("npm:@scope/tools@2", "/b", "/home"));
  assert.equal(packageIdentity("git:github.com/u/repo@tag", "/a", "/home"), packageIdentity("https://github.com/u/repo.git", "/b", "/home"));
  assert.equal(packagePath("npm:@scope/tools@1", "/a", "/home"), "/a/npm/node_modules/@scope/tools");
  assert.throws(() => packagePath("npm:../../outside", "/a", "/home"));
  assert.throws(() => packagePath("git:github.com/../../outside", "/a", "/home"));
});

test("discovery honors manifest exclusions, per-package exact rules and project package shadowing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-discovery-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const global = join(home, "agent"); const project = join(home, "project", ".pi");
  const write = (path: string, text: string) => { const dir = path.slice(0, path.lastIndexOf("/")); mkdirSync(dir, { recursive: true }); writeFileSync(path, text); };
  for (const base of [global, project]) {
    const root = join(base, "npm", "node_modules", "example");
    write(join(root, "package.json"), JSON.stringify({ pi: { skills: ["skills", "!skills/hidden/**"] } }));
    for (const name of ["one", "two", "hidden"]) write(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Test\n---\nInstructions`);
  }
  const found = discover([
    { base: global, scope: "global", settings: { packages: ["npm:example@1"] } },
    { base: project, scope: "project", settings: { packages: [{ source: "npm:example@2", skills: ["!skills/two/**", "+skills/two", "-skills/one"] }] } },
  ], home);
  assert.equal(found.resources.some((r) => r.scope === "global"), false);
  assert.equal(found.resources.find((r) => r.name === "one")?.enabled, false);
  assert.equal(found.resources.find((r) => r.name === "two")?.enabled, true);
  assert.equal(found.resources.some((r) => r.name === "hidden"), false);
});
