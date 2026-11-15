import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectRoot } from "../tools/features.mjs";
import { renderFeatureCatalog, replaceFeatureCatalog, updateReadme } from "../tools/readme.mjs";
import { stageReadme } from "../tools/readme-hook.mjs";

const start = "<!-- zeonest:features:start -->";
const end = "<!-- zeonest:features:end -->";
const document = `# 手写标题\n\n${start}\n旧目录\n${end}\n\n保留手写说明。\n`;
const metadata = (id: string) => ({
  id, name: `功能 ${id}`, description: "功能说明", version: "0.1.0", tags: ["pi", "test"], author: "作者",
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function fixture(t: TestContext, repository = false) {
  const root = await mkdtemp(path.join(tmpdir(), "zeonest-readme-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), document);
  if (repository) {
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "core.hooksPath", path.join(root, "disabled-hooks"));
    await updateReadme(root);
    git(root, "add", "README.md");
    git(root, "commit", "--quiet", "-m", "Initial documentation");
  }
  return root;
}

async function feature(root: string, id: string, patch: Record<string, unknown> = {}) {
  const directory = path.join(root, "features", id);
  await mkdir(path.join(directory, "client"), { recursive: true });
  await writeFile(path.join(directory, "feature.json"), JSON.stringify({ ...metadata(id), ...patch }));
  await writeFile(path.join(directory, "client/index.ts"), "export default () => () => {};\n");
  await writeFile(path.join(directory, "README.md"), "# 功能说明\n");
}

test("README catalog includes all six metadata fields, documentation links and empty tags", () => {
  const output = renderFeatureCatalog([{ metadata: metadata("alpha") }, { metadata: { ...metadata("beta"), tags: [] } }]);
  assert.match(output, /当前包含 \*\*2\*\* 个子功能/);
  assert.ok(output.includes("| [功能 alpha](features/alpha/README.md)<br><code>alpha</code> | 功能说明 | 0.1.0 | <code>pi</code> <code>test</code> | 作者 |"));
  assert.ok(output.includes("| [功能 beta](features/beta/README.md)<br><code>beta</code> | 功能说明 | 0.1.0 | — | 作者 |"));
  assert.match(renderFeatureCatalog([]), /当前尚未包含子功能/);
});

test("README catalog treats Markdown, HTML, pipes, backslashes and newlines as plain metadata", () => {
  const output = renderFeatureCatalog([{ metadata: {
    ...metadata("alpha"), name: "[链接]*_`", description: "A|B\r\n<script>&\\C\rD\nE",
    tags: ["x|y", "<tag>"], author: "[作者](https://example.invalid)",
  } }]);
  assert.ok(output.includes("[&#91;链接&#93;&#42;&#95;&#96;](features/alpha/README.md)"));
  assert.ok(output.includes("A&#124;B<br>&#60;script&#62;&#38;&#92;C<br>D<br>E"));
  assert.ok(output.includes("<code>x&#124;y</code> <code>&#60;tag&#62;</code>"));
  assert.ok(output.includes("&#91;作者&#93;(https://example.invalid)"));
  assert.doesNotMatch(output, /<script>|\[作者\]/);
  assert.equal(output.split("\n").at(-1)!.split("|").length, 7);
});

test("README generation handles an empty repository, is idempotent and checks without writing", async (t) => {
  const root = await fixture(t);
  await assert.rejects(updateReadme(root, { check: true }), /out of date/);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), document);
  assert.equal(await updateReadme(root), true);
  assert.equal(await updateReadme(root), false);
  assert.equal(await updateReadme(root, { check: true }), false);
  const updated = await readFile(path.join(root, "README.md"), "utf8");
  assert.ok(updated.startsWith("# 手写标题\n\n"));
  assert.ok(updated.endsWith("\n\n保留手写说明。\n"));
});

test("README generation discovers metadata additions, updates and removals in stable ID order", async (t) => {
  const root = await fixture(t);
  await feature(root, "zeta");
  await feature(root, "alpha");
  await updateReadme(root);
  const initial = await readFile(path.join(root, "README.md"), "utf8");
  assert.ok(initial.indexOf("features/alpha/") < initial.indexOf("features/zeta/"));
  await feature(root, "alpha", { name: "新名称", version: "1.2.3-beta.1+docs", tags: [] });
  await assert.rejects(updateReadme(root, { check: true }), /out of date/);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), initial);
  await rm(path.join(root, "features/zeta"), { recursive: true });
  await updateReadme(root);
  const updated = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(updated, /当前包含 \*\*1\*\* 个子功能/);
  assert.match(updated, /新名称/);
  assert.match(updated, /1\.2\.3-beta\.1\+docs/);
  assert.doesNotMatch(updated, /zeta/);
});

test("README generation rejects invalid metadata without modifying the document", async (t) => {
  const root = await fixture(t);
  await feature(root, "alpha", { version: "not-semver" });
  await assert.rejects(updateReadme(root), /SemVer/);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), document);
});

test("README replacement preserves CRLF and rejects missing, repeated or reversed markers", () => {
  const output = replaceFeatureCatalog(document.replace(/\n/g, "\r\n"), []);
  assert.ok(output.startsWith("# 手写标题\r\n\r\n"));
  assert.ok(output.endsWith("\r\n\r\n保留手写说明。\r\n"));
  assert.doesNotMatch(output.replace(/\r\n/g, ""), /\n/);
  for (const invalid of ["", start, end, end + start, start + start + end, start + end + end]) {
    assert.throws(() => replaceFeatureCatalog(invalid, []), /exactly one ordered pair/);
  }
});

test("pre-commit generates from staged metadata without staging unrelated README edits or untracked features", async (t) => {
  const root = await fixture(t, true);
  await feature(root, "alpha");
  const file = path.join(root, "README.md");
  const baseline = await readFile(file, "utf8");
  await writeFile(file, baseline.replace("手写标题", "已暂存标题"));
  git(root, "add", "README.md", "features/alpha");
  await writeFile(file, baseline.replace("手写标题", "未暂存标题"));
  await feature(root, "alpha", { name: "未暂存元数据" });
  await feature(root, "untracked");

  assert.equal(await stageReadme(root), true);
  const staged = git(root, "show", ":README.md");
  const working = await readFile(file, "utf8");
  assert.match(staged, /已暂存标题/);
  assert.doesNotMatch(staged, /未暂存标题|未暂存元数据|untracked/);
  assert.match(staged, /功能 alpha/);
  assert.match(working, /未暂存标题/);
  assert.match(working, /功能 alpha/);
  assert.equal(JSON.parse(await readFile(path.join(root, "features/alpha/feature.json"), "utf8")).name, "未暂存元数据");
  assert.equal(JSON.parse(git(root, "show", ":features/alpha/feature.json")).name, "功能 alpha");
  assert.doesNotMatch(git(root, "diff", "--cached", "--name-only"), /untracked/);
  assert.equal(await stageReadme(root), false);
});

test("pre-commit supports initial commits, metadata-only updates and feature deletion", async (t) => {
  const root = await fixture(t, true);
  await feature(root, "alpha");
  git(root, "add", "features/alpha");
  await stageReadme(root);
  git(root, "commit", "--quiet", "-m", "Add feature");
  await feature(root, "alpha", { description: "只修改元数据，无需构建" });
  git(root, "add", "features/alpha/feature.json");
  assert.equal(await stageReadme(root), true);
  assert.match(git(root, "show", ":README.md"), /只修改元数据，无需构建/);
  git(root, "commit", "--quiet", "-m", "Metadata only");
  git(root, "rm", "-r", "--quiet", "features/alpha");
  assert.equal(await stageReadme(root), true);
  assert.match(git(root, "show", ":README.md"), /当前尚未包含子功能/);
  assert.doesNotMatch(git(root, "show", ":README.md"), /features\/alpha/);
});

test("pre-commit skips unrelated changes and leaves the README index intact on validation failure", async (t) => {
  const root = await fixture(t, true);
  await writeFile(path.join(root, "notes.txt"), "Unrelated change\n");
  git(root, "add", "notes.txt");
  assert.equal(await stageReadme(root), false);
  await feature(root, "alpha", { author: "" });
  git(root, "add", "features/alpha");
  const before = git(root, "show", ":README.md");
  await assert.rejects(stageReadme(root), /Missing feature author/);
  assert.equal(git(root, "show", ":README.md"), before);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), before);
});

test("pre-commit does not stage generated changes if the working README markers are invalid", async (t) => {
  const root = await fixture(t, true);
  await feature(root, "alpha");
  git(root, "add", "features/alpha");
  const before = git(root, "show", ":README.md");
  await writeFile(path.join(root, "README.md"), "Unstaged document without markers\n");
  await assert.rejects(stageReadme(root), /exactly one ordered pair/);
  assert.equal(git(root, "show", ":README.md"), before);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Unstaged document without markers\n");
});

test("README CLI supports generation and non-writing freshness checks and rejects unknown options", async (t) => {
  const root = await fixture(t);
  await cp(path.join(projectRoot, "tools"), path.join(root, "tools"), { recursive: true });
  const run = (...args: string[]) => execFileSync(process.execPath, ["tools/readme.mjs", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" });
  assert.throws(() => run("--check"), /out of date/);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), document);
  assert.match(run(), /Updated README/);
  assert.match(run("--check"), /up to date/);
  assert.throws(() => run("--invalid"), /Usage/);
});

test("pre-commit preserves the index and worktree line endings independently with core.autocrlf", async (t) => {
  const root = await fixture(t, true);
  git(root, "config", "core.autocrlf", "true");
  await feature(root, "alpha");
  git(root, "add", "features/alpha");
  const file = path.join(root, "README.md");
  await writeFile(file, (await readFile(file, "utf8")).replace(/\n/g, "\r\n"));
  assert.equal(await stageReadme(root), true);
  assert.doesNotMatch(git(root, "show", ":README.md"), /\r/);
  const working = await readFile(file, "utf8");
  assert.match(working, /功能 alpha/);
  assert.doesNotMatch(working.replace(/\r\n/g, ""), /\n/);
});

test("the installed pre-commit hook updates an initial commit and prevents invalid metadata commits", async (t) => {
  const root = await fixture(t);
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  for (const item of [".githooks", "tools"]) {
    await cp(path.join(projectRoot, item), path.join(root, item), { recursive: true });
  }
  git(root, "config", "core.hooksPath", ".githooks");
  await feature(root, "alpha");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "Initial feature");
  assert.match(git(root, "show", "HEAD:README.md"), /功能 alpha/);
  assert.equal(git(root, "status", "--porcelain"), "");
  const head = git(root, "rev-parse", "HEAD");
  await feature(root, "alpha", { version: "invalid" });
  git(root, "add", "features/alpha/feature.json");
  assert.throws(() => git(root, "commit", "--quiet", "-m", "Invalid metadata"), /SemVer/);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
});
