import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { Configuration, TargetKey } from "../shared/contracts";
import { workspaceRoot } from "../server/paths";
import { Workbench, type Workspace } from "../server/workbench";

function fixture(t: TestContext) {
  const root = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-gradle-cache-")));
  const store = join(root, "zeonest", "build-workbench");
  const put = (file: string, body: string, executable = false) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, executable ? `#!${process.execPath}\n${body}` : body, { mode: executable ? 0o700 : 0o600 });
  };
  const jdks = [join(root, "jdk17"), join(root, "jdk21")] as const;
  jdks.forEach((jdk, i) => put(join(jdk, "bin/java"), `console.log('openjdk version "${17 + i * 4}.0.1"');`, true));
  const env = { HOME: root, JAVA_HOME: jdks[0], PATH: [...jdks.map((dir) => join(dir, "bin")), dirname(process.execPath)].join(delimiter), GRADLE_USER_HOME: join(root, "gradle-home") };
  const instances: Workbench[] = [];
  t.after(async () => {
    await Promise.all(instances.map((w) => w.close()));
    rmSync(root, { recursive: true, force: true });
  });
  const open = (environment: NodeJS.ProcessEnv = env) => { const w = new Workbench(store, environment); instances.push(w); return w; };
  function project(path: string, settings = "rootProject.name='fixture'\n") {
    put(join(path, "settings.gradle"), settings);
    put(join(path, "module/build.gradle"), "// module build\n");
    put(join(path, "gradle/wrapper/gradle-wrapper.properties"), "distributionUrl=https://example.test/gradle.zip\n");
    put(join(path, "gradle/wrapper/gradle-wrapper.jar"), "fixture-wrapper");
    put(join(path, "gradlew"), `
const fs = require('node:fs');
if (process.argv.includes('tasks')) {
  fs.appendFileSync('probe-count.txt', '.');
  console.log('Build tasks\\n-----------\\nmodule:assemble');
  if (process.argv.includes('-Pchannel=prod')) console.log('module:assembleProd');
} else console.log('built');
`, true);
  }
  return { root, store, jdks, env, put, open, project };
}

const probe = (project = "."): TargetKey => ({ adapter: "gradle", project, name: "tasks --all" });
const key = (name: string, project = "."): TargetKey => ({ ...probe(project), name });
const found = (w: Workbench, ws: Workspace, name: string) => w.discover(ws).targets.find((t) => t.name === name && t.confirmed);
function configuration(w: Workbench, ws: Workspace, target: TargetKey, options: string[] = [], index = 0): Configuration {
  const tool = w.tools(ws, target).candidates[index];
  assert.ok(tool);
  return { target, tool: tool.id, options, artifacts: [] };
}
async function execute(w: Workbench, ws: Workspace, c: Configuration) {
  const submitted = w.start(ws, c, w.preview(ws, c).fingerprint);
  assert.equal(submitted.kind, "started");
  for (let attempt = 0; attempt < 200; attempt++) {
    const { run } = w.detail(ws, submitted.run.id, 0);
    if (run.endedAt) { assert.equal(run.status, "success", run.result); return run; }
    await wait(15);
  }
  assert.fail("fixture did not settle");
}

test("Gradle shares canonical project results independently of workspace history and saved settings", { skip: process.platform === "win32" }, async (t) => {
  const { root, store, project, open } = fixture(t);
  const checkout = join(root, "checkout");
  const directory = join(checkout, "java");
  const other = join(root, "other-worktree", "java");
  project(directory);
  project(other);
  const link = join(root, "alias");
  symlinkSync(directory, link);
  symlinkSync(other, join(checkout, "outside"));
  const author = { id: "writer", root: checkout };
  const peer = { id: "reader", root: workspaceRoot(link) };
  const isolated = { id: "independent", root: other };
  const name = ":module:assembleProd";
  const property = "-Pchannel=prod";
  const count = () => readFileSync(join(directory, "probe-count.txt"), "utf8");
  const w = open();
  assert.equal(found(w, peer, name), undefined);
  assert.ok(!w.discover(author).targets.some(({ project }) => project === "outside"));
  assert.equal(existsSync(store), false, "refresh is read-only");
  const c = configuration(w, author, probe("java"), [property]);
  await w.verify(author, c);
  w.save(author, { ...c, name: "仅原工作区" });
  const first = await execute(w, author, c);
  assert.ok(first.confirmedTargets?.includes(name));
  assert.ok(w.detail(author, first.id, 0).rows.some(({ text }) => text.includes(name.slice(1))));
  assert.equal(found(w, peer, name)?.project, ".");
  assert.deepEqual(found(w, peer, name)?.probeOptions, [property]);
  assert.equal(found(w, isolated, name), undefined);
  assert.equal(count(), ".");
  assert.deepEqual(w.list(peer), []);
  assert.deepEqual(w.discover(peer).configurations, []);
  assert.throws(() => w.detail(peer, first.id, 0), /当前工作区没有/u);
  assert.throws(() => w.stop(peer, first.id), /当前工作区没有/u);
  assert.throws(() => w.retry(peer, first.id), /当前工作区没有/u);
  const matched = configuration(w, peer, key(name), [property]);
  assert.ok(w.preview(peer, matched).command.argv.includes(name));
  assert.throws(() => w.preview(peer, { ...matched, options: [] }), /未确认此目标/u);
  assert.throws(() => w.preview(peer, { ...matched, tool: configuration(w, peer, key(name), [property], 1).tool }), /未确认此目标/u);
  assert.throws(() => w.start(peer, matched, w.preview(peer, matched).fingerprint), /请先检查/u);
  const build = { ...c, target: key(name, "java") };
  for (let i = 0; i < 24; i++) await execute(w, author, build);
  assert.equal(w.list(author).length, 24);
  assert.throws(() => w.detail(author, first.id, 0), /当前工作区没有/u);
  assert.equal(count(), ".");
  const [cacheFile] = readdirSync(join(store, "gradle-tasks"));
  assert.ok(cacheFile && cacheFile.endsWith(".json"));
  const data = readFileSync(join(store, "gradle-tasks", cacheFile), "utf8");
  assert.ok(data.includes(name));
  assert.ok(!data.includes(first.id) && !data.includes("仅原工作区"));
  await w.close();
  const reopened = open();
  assert.ok(found(reopened, peer, name));
  assert.ok(found(reopened, author, name));
  assert.equal(found(reopened, isolated, name), undefined);
  assert.deepEqual(reopened.list(peer), []);
  assert.throws(() => reopened.detail(author, first.id, 0), /当前工作区没有/u);
  assert.equal(count(), ".", "refresh after a restart must not run Gradle");
});

test("Gradle cache revalidates declarations, Wrapper, Java, and effective Gradle environment", { skip: process.platform === "win32" }, async (t) => {
  const { root, jdks, env, put, project, open } = fixture(t);
  const directory = join(root, "checkout");
  project(directory);
  const observer = { id: "observer", root: directory };
  const workspace = { id: "writer", root: directory };
  const name = ":module:assemble";
  const w = open();
  async function refresh() {
    const c = configuration(w, workspace, probe());
    await w.verify(workspace, c);
    await execute(w, workspace, c);
    assert.ok(found(w, observer, name));
  }
  await refresh();
  for (const [file, text] of [
    [join(directory, "module/build.gradle"), "// changed declaration\n"],
    [join(directory, "gradle/wrapper/gradle-wrapper.jar"), "updated fixture wrapper"],
    [join(jdks[0], "release"), "JAVA_VERSION=17.0.2"],
    [join(env.GRADLE_USER_HOME, "gradle.properties"), "channel=dev"],
  ] as const) {
    put(file, text);
    assert.equal(found(w, observer, name), undefined, file);
    await refresh();
  }
  await w.close();
  const changedEnvironment = open({ ...env, ORG_GRADLE_PROJECT_channel: "test" });
  assert.equal(found(changedEnvironment, observer, name), undefined);
  assert.equal(readFileSync(join(directory, "probe-count.txt"), "utf8"), ".....");
});

test("untrackable Gradle declarations keep a one-use result scoped to the workspace session", { skip: process.platform === "win32" }, async (t) => {
  const { root, store, project, open } = fixture(t);
  const directory = join(root, "checkout");
  project(directory, "apply from: 'shared.gradle'\n");
  const workspace = { id: "writer", root: directory };
  const peer = { ...workspace, id: "reader" };
  const name = ":module:assemble";
  const w = open();
  const c = configuration(w, workspace, probe());
  await w.verify(workspace, c);
  await execute(w, workspace, c);
  assert.ok(found(w, workspace, name));
  assert.equal(found(w, peer, name), undefined);
  assert.equal(existsSync(join(store, "gradle-tasks")), false);
  await execute(w, workspace, { ...c, target: key(name) });
  assert.equal(found(w, workspace, name), undefined);
  await execute(w, workspace, c);
  await w.close();
  assert.equal(found(open(), workspace, name), undefined);
});
