import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { discover as discoveryContract, type Configuration, type TargetKey } from "../shared/contracts";
import contribute from "../server/index";
import contributeRpc from "../server/rpc";
import { digest, workspaceRoot } from "../server/paths";
import { Workbench, type Workspace } from "../server/workbench";

function fixture(t: TestContext) {
  const root = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-gradle-cache-")));
  const store = join(root, "zeonest", "build-workbench");
  const put = (file: string, body: string, executable = false) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, executable ? `#!${process.execPath}\n${body}` : body, { mode: executable ? 0o700 : 0o600 });
  };
  const jdks = [join(root, "jdk17"), join(root, "jdk21")] as const;
  jdks.forEach((jdk, i) => {
    put(join(jdk, "bin/java"), `console.log('openjdk version "${17 + i * 4}.0.1"');`, true);
    for (const file of ["release", "lib/modules", "lib/server/libjvm.so"]) put(join(jdk, file), "JDK fixture");
  });
  const distro = join(root, "gradle");
  put(join(distro, "lib/gradle-launcher-9.5.1.jar"), "launcher");
  const env = { HOME: root, PASEO_HOME: root, JAVA_HOME: jdks[0], PATH: [join(distro, "bin"), ...jdks.map((dir) => join(dir, "bin")), dirname(process.execPath)].join(delimiter), GRADLE_USER_HOME: join(root, "gradle-home") };
  const instances: Workbench[] = [];
  t.after(async () => {
    await Promise.all(instances.map((w) => w.close()));
    rmSync(root, { recursive: true, force: true });
  });
  const open = (environment: NodeJS.ProcessEnv = env) => { const w = new Workbench(store, environment); instances.push(w); return w; };
  function project(path: string, settings = "rootProject.name='fixture'\ninclude 'module'\n") {
    put(join(path, "settings.gradle"), settings);
    put(join(path, "module/build.gradle"), "// module build\n");
  }
  put(join(distro, "bin/gradle"), `
const fs = require('node:fs');
if (process.argv.includes('tasks')) {
  fs.appendFileSync('probe-count.txt', '.');
  console.log('Build tasks\\n-----------\\nmodule:assemble');
  if (process.argv.some((arg) => arg.startsWith('-Pchannel='))) console.log('module:assembleProd');
  if (process.argv.includes('--parallel')) console.log('module:assembleParallel');
} else {
  if (process.argv.includes(':module:assembleParallel') && !process.argv.includes('--parallel')) process.exit(90);
  if (process.argv.includes(':module:assembleParallel')) setTimeout(() => {}, 250);
  console.log('built');
}
`, true);
  return { root, store, distro, jdks, env, put, open, project };
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
  const { root, store, project, open, env } = fixture(t);
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
  const property = "-Pchannel=private-fixture-credential";
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
  assert.deepEqual(found(w, author, name)?.probeOptions, [property]);
  assert.equal(found(w, peer, name)?.probeOptions, undefined);
  assert.doesNotMatch(JSON.stringify(w.discover(peer)), /private-fixture-credential/u);
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
  assert.ok(!data.includes(first.id) && !data.includes("仅原工作区") && !data.includes(property));
  await w.close();
  const reopened = open();
  assert.ok(found(reopened, peer, name));
  assert.doesNotMatch(JSON.stringify(reopened.discover(peer)), /private-fixture-credential/u);
  assert.ok(found(reopened, author, name));
  assert.equal(found(reopened, isolated, name), undefined);
  assert.deepEqual(reopened.list(peer), []);
  assert.throws(() => reopened.detail(author, first.id, 0), /当前工作区没有/u);
  assert.equal(count(), ".", "refresh after a restart must not run Gradle");
  await reopened.close();

  // Exercise the registered RPC, including SDK output schema and ID-to-directory resolution.
  type DiscoverHandler = (input: { workspaceId: string }, context: PluginHandlerContext) => Promise<unknown>;
  const handlers = new Map<string, DiscoverHandler>();
  const server = { handle: (contract: { name: string }, handler: DiscoverHandler) => {
    handlers.set(contract.name, handler);
  } } as unknown as PluginServerContext;
  const originalEnv = process.env;
  process.env = { ...env };
  const cleanup = (() => { try { return contribute(server); } finally { process.env = originalEnv; } })();
  const cleanupRpc = contributeRpc(server);
  t.after(async () => { cleanupRpc(); await cleanup(); });
  const handler = handlers.get(discoveryContract.name);
  assert.ok(handler);
  const context = { paseo: { workspaces: { ref: (id: string) => ({ refresh: async () => id === peer.id
    ? { id, workspaceDirectory: link } : undefined }) } } } as unknown as PluginHandlerContext;
  const received = discoveryContract.output.parse(await handler({ workspaceId: peer.id }, context));
  assert.ok(received.targets.some((target) => target.name === name && target.confirmed));
  assert.doesNotMatch(JSON.stringify(received), /private-fixture-credential/u);
  assert.equal(received.targets.find((target) => target.name === name)?.probeOptions, undefined);
  assert.deepEqual(received.configurations, []);
  assert.equal(count(), ".");
});

test("Gradle cache revalidates declarations, distribution, Java, and effective Gradle environment", { skip: process.platform === "win32" }, async (t) => {
  const { root, jdks, env, distro, put, project, open } = fixture(t);
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
    [join(distro, "lib/gradle-launcher-9.5.1.jar"), "updated fixture distribution"],
    [join(jdks[0], "release"), "JAVA_VERSION=17.0.2"],
  ] as const) {
    put(file, text);
    assert.equal(found(w, observer, name), undefined, file);
    await refresh();
  }
  await w.close();
  const changedEnvironment = open({ ...env, ORG_GRADLE_PROJECT_channel: "test" });
  assert.equal(found(changedEnvironment, observer, name), undefined);
  assert.equal(readFileSync(join(directory, "probe-count.txt"), "utf8"), "....");
  for (const file of [join(env.GRADLE_USER_HOME, "init.d/custom.gradle"), join(distro, "init.d/custom.gradle")]) {
    put(file, "// can inspect arbitrary external inputs");
    const instance = open();
    assert.equal(found(instance, observer, name), undefined);
    const c = configuration(instance, workspace, probe());
    await instance.verify(workspace, c);
    await execute(instance, workspace, c);
    assert.ok(found(instance, workspace, name));
    assert.equal(found(instance, observer, name), undefined);
    await instance.close();
    rmSync(file);
  }
});

test("untrackable Gradle declarations keep a one-use result scoped to the workspace session", { skip: process.platform === "win32" }, async (t) => {
  const { root, store, project, put, open } = fixture(t);
  const directory = join(root, "checkout");
  project(directory, 'dependencyResolutionManagement { versionCatalogs { create("variants") { from(files("variants.toml")) } } }\n');
  put(join(directory, "variants.toml"), '[versions]\nflavor="Blue"\n');
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
  put(join(directory, "variants.toml"), '[versions]\nflavor="Green"\n');
  await w.close();
  assert.equal(found(open(), workspace, name), undefined);
});

test("coexisting Groovy and Kotlin settings invalidate a shared result and produce only a one-use result", { skip: process.platform === "win32" }, async (t) => {
  const { root, project, put, open } = fixture(t);
  const directory = join(root, "checkout");
  project(directory);
  const author = { id: "writer", root: directory };
  const peer = { ...author, id: "reader" };
  const w = open();
  const c = configuration(w, author, probe());
  await w.verify(author, c);
  await execute(w, author, c);
  const name = ":module:assemble";
  assert.ok(found(w, peer, name));
  put(join(directory, "settings.gradle.kts"), 'rootProject.name = "kotlinAlternate"\n');
  assert.equal(found(w, peer, name), undefined);
  await w.verify(author, c);
  await execute(w, author, c);
  assert.ok(found(w, author, name));
  assert.equal(found(w, peer, name), undefined);
  await execute(w, author, { ...c, target: key(name) });
  assert.equal(found(w, author, name), undefined);
});

test("Gradle uses ordered global args at submit and dequeue; old cache does not export raw options", { skip: process.platform === "win32" }, async (t) => {
  const { root, store, project, open, put } = fixture(t);
  const directory = join(root, "checkout");
  project(directory);
  const author = { id: "writer", root: directory };
  const peer = { ...author, id: "reader" };
  const name = ":module:assembleParallel";
  const options = ["--offline", "--parallel", "--max-workers", "2"];
  const w = open();
  const c = configuration(w, author, probe(), [...options, "--workbench-task-filter=Parallel"]);
  await w.verify(author, c);
  await execute(w, author, c);
  const peerConfig = configuration(w, peer, key(name), options);
  await w.verify(peer, peerConfig);
  assert.ok(found(w, peer, name));
  assert.throws(() => w.preview(peer, { ...peerConfig, options: ["--offline", "--max-workers", "2"] }), /未确认此目标/u);
  assert.throws(() => w.preview(peer, { ...peerConfig, options: ["--parallel", "--offline", "--max-workers", "2"] }), /未确认此目标/u);
  const withTaskOption = { ...peerConfig, options: [...options, "--rerun"] };
  const start = (config: Configuration) => {
    const reply = w.start(peer, config, w.preview(peer, config).fingerprint);
    assert.equal(reply.kind, "started");
    return reply.run;
  };
  assert.equal(start(withTaskOption).status, "running");
  const queued = start(peerConfig);
  assert.equal(queued.status, "queued");
  put(join(directory, "module/build.gradle"), "// update while waiting");
  for (let i = 0; i < 200 && !w.detail(peer, queued.id, 0).run.endedAt; i++) await wait(15);
  assert.notEqual(w.detail(peer, queued.id, 0).run.status, "success");
  assert.ok(!w.detail(peer, queued.id, 0).rows.some(({ text }) => text === "built"));
  await w.close();
  const file = join(store, "gradle-tasks", digest(directory) + ".json");
  const old = JSON.parse(readFileSync(file, "utf8")) as { version: number; results: Array<Record<string, unknown>> };
  old.version = 1;
  old.results[0]!.options = ["-Pkey=legacy-private-value", "-Dsecret=legacy-private-value"];
  put(file, JSON.stringify(old));
  const legacy = open();
  assert.equal(found(legacy, peer, name), undefined);
  assert.doesNotMatch(JSON.stringify(legacy.discover(peer)), /legacy-private-value/u);
});
