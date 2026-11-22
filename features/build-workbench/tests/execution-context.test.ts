import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Configuration, TargetKey } from "../shared/contracts";
import { discoverProjects } from "../server/projects";
import { buildArguments, toolchains } from "../server/toolchains";
import { Workbench, type Workspace } from "../server/workbench";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zeonest-context-")));
  const put = (name: string, contents: string | object, script = false) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, script ? `#!${process.execPath}\n${contents}` : typeof contents === "string" ? contents : JSON.stringify(contents), { mode: script ? 0o700 : 0o600 });
    return path;
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, put };
}

async function finish(w: Workbench, ws: Workspace, id: string) {
  for (let i = 0; i < 160; i++) {
    const value = w.detail(ws, id, 0);
    if (value.run.endedAt) return value;
    await delay(25);
  }
  assert.fail("run did not finish");
}

function config(w: Workbench, ws: Workspace, target: TargetKey, tool = w.tools(ws, target).candidates[0]?.id): Configuration {
  assert.ok(tool);
  return { target, tool, options: [], artifacts: [] };
}

function submit(w: Workbench, ws: Workspace, c: Configuration) {
  const reply = w.start(ws, c, w.preview(ws, c).fingerprint);
  assert.equal(reply.kind, "started");
  return reply.run;
}

test("pnpm root-only, brace and exclusions preserve native ownership; npm supports ordered re-inclusion", (t) => {
  const { root, put } = fixture(t);
  const scripts = { build: "not run by discovery" };
  put("package.json", { name: "root", packageManager: "pnpm@12", scripts });
  for (const name of ["a", "b", "blocked", "rogue"]) put(`packages/${name}/package.json`, { name, scripts });
  put("independent/package.json", { name: "separate", packageManager: "npm@11", scripts, workspaces: ["modules/*", "!modules/blocked", "modules/blocked"] });
  for (const name of ["ok", "blocked"]) put(`independent/modules/${name}/package.json`, { name, scripts });
  put("pnpm-workspace.yaml", "catalog: {}\n");
  const rootOnly = discoverProjects(root);
  assert.deepEqual(rootOnly.targets.map(({ project }) => project).sort(), [".", "independent", "independent/modules/blocked", "independent/modules/ok"]);
  assert.ok(rootOnly.notices.some((note) => note.includes("packages/a 不属于")));
  put("pnpm-workspace.yaml", "packages: ['!packages/blocked', 'packages/{a,b,blocked}']\n");
  const included = discoverProjects(root);
  for (const name of ["a", "b"]) {
    const project = included.targets.find((item) => item.project === `packages/${name}`);
    assert.equal(project?.adapter, "pnpm");
    assert.equal(project?.install?.cwd, ".");
  }
  assert.ok(!included.targets.some((item) => /packages\/(blocked|rogue)/u.test(item.project)));
  assert.equal(included.targets.find((item) => item.project === "independent/modules/blocked")?.install?.cwd, "independent");
  put("packages/a/.npmrc", "use-node-version=22\n");
  const runtime = discoverProjects(root);
  assert.ok(!runtime.targets.some((item) => item.project === "packages/a"));
  assert.ok(runtime.notices.some((note) => note.includes("运行时")));
});

test("JavaScript tool verification checks installation root and member independently and rejects host Node redirection", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const host = { HOME: root, PATH: [join(root, "bin"), dirname(process.execPath)].join(delimiter) };
  const node = process.versions.node;
  for (const manager of ["npm", "pnpm"] as const) {
    const path = join(root, manager);
    const script = manager === "npm" ? `console.log(JSON.stringify({node: ${JSON.stringify(node)}, npm: '11.20.0'}))` : "console.log('12.21.0')";
    const executable = put(`bin/${manager}`, script, true);
    const packages = manager === "npm" ? { workspaces: ["components/*"] } : {};
    const version = manager === "npm" ? "11.20.0" : "12.21.0";
    const writeRoot = (range: string) => put(`${manager}/package.json`, { ...packages, name: "root", packageManager: `${manager}@${version}`, engines: { node: range } });
    writeRoot("0.0.1");
    if (manager === "pnpm") put("pnpm/pnpm-workspace.yaml", 'packages: ["components/*"]');
    const writeMember = (range: string) => put(`${manager}/components/leaf/package.json`, { name: "leaf", engines: { node: range }, scripts: { build: "fixture" } });
    writeMember(node);
    const workspace = { id: manager, root: path };
    const target = { adapter: manager, project: "components/leaf", name: "build" };
    const w = new Workbench(join(root, "results"), host);
    t.after(() => w.close());
    const selection = () => config(w, workspace, target, w.tools(workspace, target).candidates.find(({ paths }) => paths[1] === executable && realpathSync(paths[0]!) === realpathSync(process.execPath))?.id);
    await assert.rejects(() => w.verify(workspace, selection()), /依赖安装根/u);
    writeRoot(node);
    writeMember("0.0.1");
    await assert.rejects(() => w.verify(workspace, selection()), /版本不符合要求/u);
    writeMember(node);
    assert.match((await w.verify(workspace, selection())).version ?? "", new RegExp(version.replaceAll(".", "\\."), "u"));
    put(".npmrc", `use-node-version=1.2.3\n`);
    await assert.rejects(() => w.verify(workspace, selection()), /无法验证所选运行时/u);
    assert.throws(() => w.preview(workspace, selection()), /无法验证所选运行时/u);
    rmSync(join(root, ".npmrc"));
  }
});

test("npm/pnpm refuse out-of-scope installation roots and scope-changing switches", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const env = { HOME: root, PATH: [join(root, "bin"), dirname(process.execPath)].join(delimiter) };
  const w = new Workbench(join(root, "state"), env);
  t.after(() => w.close());
  const scripts = { build: "fixture" };
  for (const manager of ["npm", "pnpm"] as const) {
    const mono = `${manager}-mono`;
    put(`bin/${manager}`, manager === "npm" ? `console.log(JSON.stringify({node:process.versions.node,npm:'11.20.0'}))` : "console.log('12.21.0')", true);
    put(`${mono}/package.json`, { name: "owner", ...(manager === "npm" ? { workspaces: ["packages/*"] } : {}) });
    if (manager === "pnpm") put(`${mono}/pnpm-workspace.yaml`, 'packages: ["packages/*"]\n');
    for (const name of ["alpha", "beta"]) put(`${mono}/packages/${name}/package.json`, { name, scripts, packageManager: `${manager}@${manager === "npm" ? "11" : "12"}` });
    const workspace = { id: mono, root: join(root, mono) };
    const child = { ...workspace, id: "child", root: join(workspace.root, "packages/alpha") };
    assert.ok(!w.discover(child).targets.some(({ name }) => name === "build"));
    assert.ok(w.discover(child).notices.some((notice) => notice.includes("上级工作区")));
    // Native membership also applies when the leaf has no manager hint.
    put(`${mono}/packages/alpha/package.json`, { name: "alpha", scripts });
    assert.ok(!w.discover(child).targets.some(({ name }) => name === "build"));
    assert.ok(w.discover(child).notices.some((notice) => notice.includes("请打开")));
    const target = { adapter: manager, project: "packages/alpha", name: "build" };
    const selected = config(w, workspace, target);
    put(`${mono}/.npmrc`, "audit=false\n");
    const { command } = w.preview(workspace, selected);
    assert.equal(command.cwd, "packages/alpha");
    assert.deepEqual(command.preparation?.map(({ cwd }) => cwd), ["."]);
    const version = await w.verify(workspace, selected);
    assert.ok(version.version);
    put(`${mono}/.npmrc`, manager === "npm" ? "workspace[]=beta\naudit=false\n" : "lockfile-dir=../elsewhere\n");
    assert.throws(() => w.preview(workspace, selected), /可改变.*执行范围/u);
    await assert.rejects(() => w.verify(workspace, selected), /可改变.*执行范围/u);
    const envOnly = new Workbench(join(root, `${mono}-env`), { ...env, NPM_CONFIG_WORKSPACE: "beta" });
    t.after(() => envOnly.close());
    rmSync(join(workspace.root, ".npmrc"));
    if (manager === "npm") assert.throws(() => envOnly.preview(workspace, selected), /宿主环境.*NPM_CONFIG_WORKSPACE/u);
    else {
      put(".npmrc", "prefix=~/global\n");
      assert.throws(() => w.preview(workspace, selected), /\.npmrc.*prefix.*pnpm/u);
      rmSync(join(root, ".npmrc"));
    }
  }
  put("npm-mono/standalone/package.json", { name: "standalone", scripts });
  const standalone = { id: "standalone", root: join(root, "npm-mono/standalone") };
  assert.equal(w.discover(standalone).targets.find(({ name }) => name === "build")?.project, ".");
});

test("pnpm normalizes native configuration, pins the verified manager and rechecks script scope after install", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  mkdirSync(join(root, "outside"));
  const path = [join(root, "bin"), dirname(process.execPath)].join(delimiter);
  const benign = { HOME: root, PATH: path, pnpm_config_registry: "http://127.0.0.1:1", npm_config_proxy: "http://127.0.0.1:1", PNPM_CONFIG_PM_ON_FAIL: "download" };
  const restricted = new Workbench(join(root, "restricted"), { ...benign, pnpm_config_lockfile_dir: join(root, "outside") });
  t.after(() => restricted.close());
  const makeProject = (id: string, version: string) => {
    put(`${id}/package.json`, { name: "owner", packageManager: `pnpm@${version}` });
    put(`${id}/pnpm-workspace.yaml`, 'packages: ["members/*"]\n');
    put(`${id}/members/app/package.json`, { name: "app", scripts: { build: "fixture" } });
    return { id, root: join(root, id) };
  };
  const target = { adapter: "pnpm", project: "members/app", name: "build" } as const;
  const manager = (version: string) => put("bin/pnpm", `
const fs = require('node:fs');
const cmd = process.argv[2];
if (cmd === '--version') console.log(${JSON.stringify(version)});
else {
  const p = process.env;
  if (p.PNPM_CONFIG_PM_ON_FAIL !== undefined || p.pnpm_config_registry !== 'http://127.0.0.1:1') process.exit(51);
  if (${version.startsWith("10.")} ? p.npm_config_manage_package_manager_versions !== 'false' || p.npm_config_package_manager_strict_version !== 'true' || p.pnpm_config_pm_on_fail !== undefined
    : p.pnpm_config_pm_on_fail !== 'ignore' || p.npm_config_manage_package_manager_versions !== undefined) process.exit(52);
  if (cmd === 'install' && fs.existsSync('redirect-after-install')) fs.writeFileSync('members/app/.npmrc', 'filter=wrong');
  fs.writeFileSync(cmd === 'install' ? 'installed' : 'built', process.cwd());
}`, true);
  for (const version of ["12.21.0", "10.35.1"]) {
    const w = new Workbench(join(root, `state-${version}`), benign);
    t.after(() => w.close());
    const exe = manager(version);
    const workspace = makeProject(`mono-${version}`, version);
    const select = (owner: Workbench, project = workspace) => config(owner, project, target, owner.tools(project, target).candidates.find(({ paths }) => paths[1] === exe)?.id);
    if (version.startsWith("12.")) {
      const selected = select(restricted);
      assert.throws(() => restricted.preview(workspace, selected), /pnpm_config_lockfile_dir/u);
      await assert.rejects(() => restricted.verify(workspace, selected), /pnpm_config_lockfile_dir/u);
      const wrong = makeProject("wrong-pin", "12.20.0");
      await assert.rejects(() => w.verify(wrong, select(w, wrong)), /版本不符合要求.*12\.20\.0/u);
      assert.throws(() => submit(w, wrong, select(w, wrong)), /先检查所选工具/u);
      assert.throws(() => readFileSync(join(wrong.root, "installed")), /ENOENT/u);
      for (const key of ["PNPM_CONFIG_FILTER", "npm_config_modules_dir"]) {
        const redirect = new Workbench(join(root, key), { ...benign, [key]: "secret-value" });
        t.after(() => redirect.close());
        assert.throws(() => redirect.preview(workspace, select(redirect)), (error: Error) => error.message.includes(key) && !error.message.includes("secret-value"));
      }
      put("pnpm-config/pnpm/config.yaml", "lockfileDir: /not-the-approved-root\n");
      const globalConfig = new Workbench(join(root, "global-pnpm"), { ...benign, XDG_CONFIG_HOME: join(root, "pnpm-config") });
      t.after(() => globalConfig.close());
      assert.throws(() => globalConfig.preview(workspace, select(globalConfig)), /全局 pnpm config\.yaml.*lockfileDir/u);
      const changed = makeProject("changed-during-install", version);
      put("changed-during-install/redirect-after-install", "");
      await w.verify(changed, select(w, changed));
      const stopped = await finish(w, changed, submit(w, changed, select(w, changed)).id);
      assert.equal(stopped.run.status, "failed");
      assert.match(stopped.run.result ?? "", /\.npmrc 的 filter/u);
      assert.throws(() => readFileSync(join(changed.root, target.project, "built")), /ENOENT/u);
    }
    const selected = select(w);
    await w.verify(workspace, selected);
    assert.equal((await finish(w, workspace, submit(w, workspace, selected).id)).run.status, "success");
    assert.equal(readFileSync(join(workspace.root, "installed"), "utf8"), workspace.root);
    assert.equal(readFileSync(join(workspace.root, target.project, "built"), "utf8"), join(workspace.root, target.project));
  }
});

test("npm permits a user global-install prefix without accepting scope overrides", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const workspace = { id: "npm", root: join(root, "mono") };
  put("mono/package.json", { name: "parent", workspaces: ["desktop"] });
  put("mono/desktop/package.json", { name: "desktop", scripts: { build: "fixture" } });
  put("home/.npmrc", 'prefix="${HOME}/global install"\n');
  const npm = put("bin/npm", `
if (process.argv.includes('--versions')) console.log(JSON.stringify({node:process.versions.node,npm:'11.20.0'}));
else require('node:fs').writeFileSync(process.argv.includes('install') ? 'installed' : 'built', process.cwd());`, true);
  const service = (extra = {}) => new Workbench(join(root, "state"), { HOME: join(root, "home"), PATH: [join(root, "bin"), dirname(process.execPath)].join(delimiter), ...extra });
  const w = service();
  t.after(() => w.close());
  const target = { adapter: "npm", project: "desktop", name: "build" } as const;
  const selected = config(w, workspace, target, w.tools(workspace, target).candidates.find(({ paths }) => paths[1] === npm)?.id);
  await w.verify(workspace, selected);
  assert.equal((await finish(w, workspace, submit(w, workspace, selected).id)).run.status, "success");
  assert.equal(readFileSync(join(workspace.root, "installed"), "utf8"), workspace.root);
  assert.equal(readFileSync(join(workspace.root, "desktop/built"), "utf8"), join(workspace.root, "desktop"));
  put("home/global install/etc/npmrc", "workspace=wrong\n");
  assert.throws(() => w.preview(workspace, selected), /global install\/etc\/npmrc.*workspace/u);
  rmSync(join(root, "home/global install/etc/npmrc"));
  put("home/alternate.rc", "workspace=wrong\n");
  put("mono/.npmrc", "userconfig=${HOME}/alternate.rc\n");
  assert.throws(() => w.preview(workspace, selected), /alternate\.rc.*workspace/u);
  rmSync(join(workspace.root, ".npmrc"));
  put("home/.npmrc", "prefix=~/global install\nglobal=true\n");
  assert.throws(() => w.preview(workspace, selected), /\.npmrc.*global/u);
  put("home/.npmrc", "prefix=~/global install\n");
  const redirected = service({ NPM_CONFIG_PREFIX: join(root, "other") });
  t.after(() => redirected.close());
  assert.throws(() => redirected.preview(workspace, selected), /宿主环境.*NPM_CONFIG_PREFIX/u);
});

test("mise TOML versions constrain both Node and the manager; unsupported declarations are diagnosed", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const nodePath = put("bin/node", "console.log('v26.1.0');", true);
  const npmPath = put("bin/npm", "console.log(JSON.stringify({node:'26.1.0',npm:'11.20.0'}));", true);
  put("project/package.json", { name: "sample", scripts: { build: "fixture" }, packageManager: "npm@11.20.0" });
  const pin = (entry: string) => put("project/.mise.toml", `[tools]\n${entry}\n`);
  const ws = { id: "mise", root: join(root, "project") };
  const w = new Workbench(join(root, "state"), { HOME: root, PATH: join(root, "bin") });
  t.after(() => w.close());
  const select = () => {
    const target = { adapter: "npm", project: ".", name: "build" } as const;
    const choice = w.tools(ws, target).candidates.find(({ paths }) => paths.includes(nodePath) && paths.includes(npmPath));
    assert.ok(choice);
    return config(w, ws, target, choice.id);
  };
  pin('node={version="22"}');
  await assert.rejects(() => w.verify(ws, select()), /需要 Node 22/u);
  pin('node=["22", "26"]');
  await assert.rejects(() => w.verify(ws, select()), /需要 Node 22/u);
  pin('node=[{version="26"}, "22"]\nnpm="10"');
  await assert.rejects(() => w.verify(ws, select()), /npm 10/u);
  pin('node="lts"');
  await assert.rejects(() => w.verify(ws, select()), /需要 Node lts/u);
  pin('node={other="22"}');
  assert.ok(!w.discover(ws).targets.some(({ name }) => name === "build"));
  assert.ok(w.discover(ws).notices.some((note) => /无法确认 mise 的 node 声明/u.test(note)));
  pin('node={version="26"}\nnpm="11"');
  assert.match((await w.verify(ws, select())).version ?? "", /Node v26\.1\.0/u);
});

test("Tauri accepts a unique same-directory front end without a parent package", (t) => {
  const { root, put } = fixture(t);
  put("desktop/native/Cargo.toml", '[package]\nname="desktop"\n');
  put("desktop/native/tauri.conf.json", {});
  put("desktop/native/package.json", { name: "web", devDependencies: { "@tauri-apps/cli": "^2" } });
  const match = discoverProjects(root).targets.find(({ adapter }) => adapter === "tauri");
  assert.equal(match?.cwd, "desktop/native");
  assert.equal(match?.tauri?.frontend, "desktop/native");
  assert.equal(match?.install?.cwd, "desktop/native");
  put("desktop/side/package.json", { name: "side" });
  assert.equal(discoverProjects(root).targets.find(({ adapter }) => adapter === "tauri")?.cwd, "desktop/native");
  rmSync(join(root, "desktop/native/package.json"));
  assert.ok(!discoverProjects(root).targets.some(({ adapter }) => adapter === "tauri"));
});

test("Tauri binds a colocated application package even when a parent is a package", (t) => {
  const { root, put } = fixture(t);
  put("package.json", { name: "parent", workspaces: ["desktop"], devDependencies: { "@tauri-apps/cli": "^1" } });
  put("desktop/package.json", { name: "desktop", devDependencies: { "@tauri-apps/cli": "^2" } });
  put("desktop/Cargo.toml", '[package]\nname="desktop"\n');
  put("desktop/tauri.conf.json", { build: { beforeBuildCommand: "npm run build" } });
  const target = discoverProjects(root).targets.find(({ adapter }) => adapter === "tauri");
  assert.equal(target?.project, "desktop");
  assert.equal(target?.cwd, "desktop");
  assert.deepEqual(target?.tauri?.cli, { owner: "desktop", spec: "^2" });
  assert.equal(target?.tauri?.frontend, "desktop");
  assert.equal(target?.install?.cwd, ".");
});

test("Cargo rejects external owners and nonmembers, but allows explicitly excluded and independent roots", (t) => {
  const { root, put } = fixture(t);
  put("mono/Cargo.toml", '[workspace]\nmembers=["left","right"]\nexclude=["excluded"]\n');
  for (const name of ["left", "right", "unlisted", "excluded/leaf", "independent"]) {
    put(`mono/${name}/Cargo.toml`, `[package]\nname="${name.split('/').at(-1)}"\n${name === "independent" ? "[workspace]\n" : ""}`);
  }
  put("mono/right/tauri.conf.json", "{}");
  const full = discoverProjects(join(root, "mono"));
  for (const name of ["left", "right"]) assert.equal(full.targets.find((target) => target.adapter === "cargo" && target.name === name)?.cwd, ".");
  assert.ok(!full.targets.some(({ name }) => name === "unlisted"));
  assert.ok(full.notices.some((note) => /unlisted.*未确认是成员/u.test(note)));
  for (const name of ["left", "right", "unlisted"]) {
    const result = discoverProjects(join(root, "mono", name));
    assert.ok(!result.targets.some(({ adapter }) => adapter === "cargo" || adapter === "tauri"));
    assert.ok(result.notices.some((note) => note.includes("请打开父工作区")));
  }
  for (const name of ["excluded/leaf", "independent"]) assert.ok(discoverProjects(join(root, "mono", name)).targets.some(({ adapter }) => adapter === "cargo"));
});

test("Cargo implicit members inherit workspace context and path pin; external shared targets queue", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const cargo = put("pinned/bin/cargo", `
if (process.argv.includes('--version')) console.log('cargo 1.96.0');
else {
  const fs = require('node:fs');
  const { resolve, join } = require('node:path');
  if (process.cwd().endsWith('/shared-b')) process.exit(0);
  const target = process.cwd().endsWith('/local') ? 'root-output' : '../shared';
  fs.mkdirSync(target, { recursive: true });
  const artifact = resolve(target, 'custom-name');
  fs.writeFileSync(artifact, 'result');
  console.log(JSON.stringify({ reason:'compiler-artifact', manifest_path:resolve('implicit/Cargo.toml'), filenames:[artifact] }));
  if (process.cwd().endsWith('/shared-a')) setTimeout(() => {}, 1000);
}`, true);
  put("pinned/bin/rustc", "console.log('rustc 1.96.0');", true);
  put("other/toolchains/stable-newer/bin/cargo", "console.log('cargo 1.99.0');", true);
  put("other/toolchains/stable-newer/bin/rustc", "console.log('rustc 1.99.0');", true);
  for (const name of ["local", "shared-a", "shared-b"]) {
    put(`${name}/Cargo.toml`, `[workspace]\nmembers=["explicit"]\n[workspace.package]\nrust-version="1.91"\n[workspace.dependencies]\ninherited={path="implicit"}\n`);
    put(`${name}/explicit/Cargo.toml`, `[package]\nname="explicit"\n[dependencies]\nrenamed={path="../implicit", package="implicit"}\n`);
    put(`${name}/implicit/Cargo.toml`, `[package]\nname="implicit"\nrust-version.workspace=true\n`);
    put(`${name}/rust-toolchain.toml`, '[toolchain]\npath="../pinned"\n');
    put(`${name}/.cargo/config.toml`, 'include=["base.toml","extra.toml"]\n');
    put(`${name}/.cargo/base.toml`, '[build]\ntarget-dir="first-output"\n');
    put(`${name}/.cargo/extra.toml`, name === "local" ? '[build]\ntarget-dir="root-output"\n' : '[build]\ntarget-dir="../shared"\nbuild-dir="{workspace-root}/intermediate"\n');
    put(`${name}/implicit/.cargo/config.toml`, '[build]\ntarget-dir="member-output"\n');
  }
  const env = { HOME: root, RUSTUP_HOME: join(root, "other"), PATH: process.env.PATH };
  const local = { id: "local", root: join(root, "local") };
  const target = { adapter: "cargo", project: "implicit", name: "implicit" } as const;
  const project = discoverProjects(local.root).targets.find((item) => item.name === "implicit");
  assert.ok(project);
  assert.equal(project.cwd, ".");
  assert.equal(project.requirements.rust, "1.91");
  const candidates = toolchains(project, env, new Map(), local.root);
  assert.deepEqual(candidates.map((tool) => tool.executable), [cargo]);
  assert.equal(buildArguments(local.root, project, [], candidates[0]!).cargo?.targetDir, join(local.root, "root-output"));
  const localService = new Workbench(join(root, "local-state"), env);
  t.after(() => localService.close());
  const lc = config(localService, local, target);
  await localService.verify(local, lc);
  const detail = await finish(localService, local, submit(localService, local, lc).id);
  assert.deepEqual(detail.artifacts, [{ path: "root-output/custom-name", state: "existing", origin: "native" }]);
  // A config path is interpreted relative to the directory above .cargo, as for target-dir.
  put("local/.cargo/extra.toml", '[build]\ntarget-dir="root-output"\nrustc="../other/toolchains/stable-newer/bin/rustc"\n');
  assert.throws(() => localService.preview(local, lc), /实际编译器.*不一致/u);
  put("local/.cargo/extra.toml", '[build]\ntarget-dir="root-output"\nrustc="rustc"\n');
  assert.ok(localService.preview(local, lc));
  put("local/.cargo/extra.toml", 'include=["config.toml"]\n');
  assert.throws(() => localService.preview(local, lc), /include 循环/u);
  put("local/rust-toolchain.toml", '[toolchain]\npath="../absent"\n');
  assert.equal(localService.tools(local, target).candidates.length, 0);
  assert.match(localService.tools(local, target).issues.join(""), /未找到 Cargo/u);

  const w = new Workbench(join(root, "shared-state"), env);
  t.after(() => w.close());
  const a = { id: "a", root: join(root, "shared-a") }, b = { id: "b", root: join(root, "shared-b") };
  const ca = config(w, a, target), cb = config(w, b, target);
  await w.verify(a, ca);
  await w.verify(b, cb);
  const first = submit(w, a, ca), second = submit(w, b, cb);
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  assert.deepEqual((await finish(w, a, first.id)).artifacts, [], "external outputs cannot be browsed");
  assert.equal((await finish(w, b, second.id)).run.status, "success");
  const sharedProject = discoverProjects(a.root).targets.find((item) => item.name === "implicit")!;
  const nextEnv = { ...env, CARGO_BUILD_TARGET_DIR: "../from-config-env", CARGO_TARGET_DIR: "../from-env", CARGO_BUILD_BUILD_DIR: "../temp-objects" };
  const [tool] = toolchains(sharedProject, nextEnv, new Map(), a.root);
  const context = buildArguments(a.root, sharedProject, [], tool!).cargo;
  assert.equal(context?.targetDir, join(root, "from-env"));
  assert.equal(context?.buildDir, join(root, "temp-objects"));
});

for (const { manager, catalog } of [
  { manager: "npm", catalog: undefined }, { manager: "pnpm", catalog: undefined },
  { manager: "pnpm", catalog: "default" }, { manager: "pnpm", catalog: "desktop" },
] as const) {
  test(`Tauri ${manager} ${catalog ?? "range"} resolves the member CLI and hook after cold and warm preparation`, { skip: process.platform === "win32" }, async (t) => {
    const { root, put } = fixture(t);
    const ws = { id: manager, root: join(root, "workspace") };
    const parent = (range: string) => put("workspace/package.json", { name: "parent", ...(manager === "npm" ? { workspaces: ["desktop"] } : {}), devDependencies: { "@tauri-apps/cli": range } });
    parent("^1");
    const spec = catalog === "default" ? "catalog:" : catalog ? `catalog:${catalog}` : "^2";
    put("workspace/desktop/package.json", { name: "desktop", dependencies: { "@tauri-apps/cli": spec } });
    const catalogFile = (range: string) => "packages: ['desktop']\n" + (catalog === "default" ? `catalog:\n  '@tauri-apps/cli': '${range}'\n` :
      catalog ? `catalogs:\n  ${catalog}:\n    '@tauri-apps/cli': '${range}'\n` : "");
    if (manager === "pnpm") put("workspace/pnpm-workspace.yaml", catalogFile("^2"));
    put("workspace/desktop/src-tauri/Cargo.toml", '[package]\nname="desktop"\n');
    put("workspace/desktop/src-tauri/tauri.conf.json", {});
    const oldPackage = "node_modules/@tauri-apps/cli";
    put(`workspace/${oldPackage}/package.json`, { name: "@tauri-apps/cli", version: "1.0.0", bin: { tauri: "run.js" } });
    put(`workspace/${oldPackage}/run.js`, "process.exit(51)");
    put("bin/tauri", "process.exit(52)", true);
    put("bin/assetgen", "console.log('host-asset')", true);
    put("workspace/node_modules/.bin/assetgen", "console.log('root-asset')", true);
    const memberBin = "desktop/node_modules/.bin";
    const cli = `
const fs = require('node:fs'), cp = require('node:child_process');
const hook = cp.execFileSync('/bin/sh', ['-c', 'assetgen; node -p process.execPath; cargo --version; rustc --version'], { cwd:process.env.TAURI_FRONTEND_PATH, encoding:'utf8' });
fs.writeFileSync('ran', JSON.stringify([process.cwd(), process.env.TAURI_FRONTEND_PATH, process.execPath, ...hook.trim().split('\\n')]));`;
    const nextPackage = manager === "npm" ? `desktop/${oldPackage}` : "node_modules/.pnpm/@tauri-apps+cli@2.1.0/node_modules/@tauri-apps/cli";
    const executable = put(`bin/${manager}`, `
const fs = require('node:fs');
if (process.argv.includes('--versions')) console.log(JSON.stringify({node:process.versions.node,npm:'11.20.0'}));
else if (process.argv.includes('--version')) console.log('12.21.0');
else if (process.argv.includes('install')) {
  const directory = ${JSON.stringify(nextPackage)};
  if (!fs.existsSync('skip-cli')) {
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(directory+'/package.json',JSON.stringify({name:'@tauri-apps/cli',version:'2.1.0',bin:{tauri:'cli.js'}}));
    fs.writeFileSync(directory+'/cli.js',${JSON.stringify(cli)} + (fs.existsSync('change-entry') ? ';process.exit(0)' : ''));
    fs.mkdirSync('${memberBin}',{recursive:true});
    if (!fs.existsSync('skip-assetgen')) fs.writeFileSync('${memberBin}/assetgen', '#!/bin/sh\\necho member-asset\\n', {mode:0o700});
    if (fs.existsSync('change-catalog')) fs.writeFileSync('pnpm-workspace.yaml', ${JSON.stringify(catalogFile("~2.1.0"))});
    if (${JSON.stringify(manager)} === 'pnpm' && !fs.existsSync('desktop/node_modules/@tauri-apps/cli')) {
      fs.mkdirSync('desktop/node_modules/@tauri-apps',{recursive:true});
      fs.symlinkSync(require('node:path').resolve(directory),'desktop/node_modules/@tauri-apps/cli');
    }
  }
} else process.exit(53);`, true);
    const cargo = put("rust/toolchains/fixture/bin/cargo", "console.log('cargo 1.96.0')", true);
    put("rust/toolchains/fixture/bin/rustc", "console.log('rustc 1.96.0')", true);
    const w = new Workbench(join(root, "state"), { HOME: root, RUSTUP_HOME: join(root, "rust"), PATH: [join(root, "bin"), dirname(process.execPath)].join(delimiter) });
    t.after(() => w.close());
    const target = w.discover(ws).targets.find(({ adapter }) => adapter === "tauri")!;
    const c = config(w, ws, target, w.tools(ws, target).candidates.find(({ paths }) => paths.includes(executable) && paths.includes(cargo))?.id);
    await w.verify(ws, c);
    const cold = w.preview(ws, c).command;
    assert.match(cold.argv[1]!, /依赖准备后确认/u);
    const first = await finish(w, ws, submit(w, ws, c).id);
    assert.equal(first.run.status, "success", first.run.result);
    assert.equal(first.run.command?.argv[1], join(ws.root, nextPackage, "cli.js"));
    assert.deepEqual(first.run.command?.preparation, cold.preparation);
    const assertHook = (mark: string) => {
      const [cwd, frontend, directNode, hookMark, hookNode, hookCargo, hookRustc] = JSON.parse(readFileSync(join(ws.root, "desktop/ran"), "utf8")) as string[];
      assert.deepEqual([cwd, frontend, hookMark, hookCargo, hookRustc], [join(ws.root, "desktop"), join(ws.root, "desktop"), mark, "cargo 1.96.0", "rustc 1.96.0"]);
      for (const node of [directNode, hookNode]) assert.equal(realpathSync(node!), realpathSync(cold.argv[0]!));
    };
    assertHook("member-asset");
    assert.deepEqual(w.preview(ws, c).command.argv, first.run.command?.argv);
    assert.equal((await finish(w, ws, submit(w, ws, c).id)).run.status, "success");
    assertHook("member-asset");
    put("workspace/skip-assetgen", "");
    rmSync(join(ws.root, memberBin, "assetgen"));
    assert.equal((await finish(w, ws, submit(w, ws, c).id)).run.status, "success");
    assertHook("root-asset");

    rmSync(join(ws.root, "desktop/ran"));
    if (catalog) {
      const yaml = (body: string) => put("workspace/pnpm-workspace.yaml", body);
      yaml("packages: ['desktop']\n");
      assert.throws(() => w.preview(ws, c), /未为 Tauri CLI 声明有效/u);
      if (catalog === "default") {
        yaml(catalogFile("^2") + "catalogs:\n  default: {}\n");
        assert.throws(() => w.preview(ws, c), /同时声明 catalog 和 catalogs.default/u);
      }
      yaml(catalogFile("^3"));
      await w.verify(ws, c);
      assert.match(w.preview(ws, c).command.argv[1]!, /准备后确认/u);
      const mismatched = await finish(w, ws, submit(w, ws, c).id);
      assert.match(mismatched.run.result ?? "", /仍无法核对所声明的 Tauri CLI/u);
      assert.throws(() => readFileSync(join(ws.root, "desktop/ran")), { code: "ENOENT" });
      yaml(catalogFile("^2"));
      await w.verify(ws, c);
      put("workspace/change-catalog", "");
      const updated = await finish(w, ws, submit(w, ws, c).id);
      assert.match(updated.run.result ?? "", /Tauri 项目或工具配置发生变化/u);
      assert.throws(() => readFileSync(join(ws.root, "desktop/ran")), { code: "ENOENT" });
      rmSync(join(ws.root, "change-catalog"));
      await w.verify(ws, c);
    }
    put("workspace/change-entry", "");
    const changed = await finish(w, ws, submit(w, ws, c).id);
    assert.equal(changed.run.status, "failed");
    assert.match(changed.run.result ?? "", /与预览不同.*重新预览/u);
    assert.throws(() => readFileSync(join(ws.root, "desktop/ran")), { code: "ENOENT" });
    const next = w.retry(ws, changed.run.id);
    assert.equal(next.kind, "changed");
    if (next.kind !== "changed") assert.fail("retry must request confirmation");
    const retry = w.retry(ws, changed.run.id, next.fingerprint);
    if (retry.kind !== "started") assert.fail("retry must accept the new preview");
    assert.equal((await finish(w, ws, retry.run.id)).run.status, "success");

    // npm can hoist a compatible member dependency; no .bin link is needed at either scope.
    if (manager === "npm") {
      rmSync(join(ws.root, nextPackage), { recursive: true });
      parent("^2");
      put(`workspace/${oldPackage}/package.json`, { name: "@tauri-apps/cli", version: "2.1.0", bin: "run.js" });
      const hoisted = put(`workspace/${oldPackage}/run.js`, "console.log('hoisted-cli')");
      put("workspace/skip-cli", "");
      assert.equal(w.preview(ws, c).command.argv[1], hoisted);
      const detail = await finish(w, ws, submit(w, ws, c).id);
      assert.equal(detail.run.status, "success");
      assert.ok(detail.rows.some(({ text }) => text.includes("hoisted-cli")));
    }
  });
}

test("Tauri binds sibling apps and app directories; selected child Node/Cargo leave unrelated commands alone", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const workspace = { id: "ui", root: join(root, "ui") };
  put("ui/package.json", { packageManager: "npm@11", dependencies: { "@tauri-apps/cli": "^2" } });
  for (const app of ["src-tauri", "secondary"]) {
    put(`ui/${app}/Cargo.toml`, `[package]\nname="${app}"\n`);
    put(`ui/${app}/tauri.conf.json`, {});
  }
  const tauri = discoverProjects(workspace.root).targets.filter(({ adapter }) => adapter === "tauri");
  assert.deepEqual(tauri.map(({ project, cwd }) => [project, cwd]).sort(), [["secondary", "."], ["src-tauri", "."]]);
  put("ui/overlay.json", { build: { features: ["desktop"] } });
  put("ui/node_modules/@tauri-apps/cli/package.json", { name: "@tauri-apps/cli", version: "2.0.0", bin: { tauri: "run.js" } });
  const cli = put("ui/node_modules/@tauri-apps/cli/run.js", `
const fs = require('node:fs'), cp = require('node:child_process');
const call = (cmd, args) => cp.execFileSync(cmd, args, {encoding:'utf8'}).trim();
fs.writeFileSync('resolved', JSON.stringify([process.execPath, call('cargo',['--version']), call('cc',[]), call('protoc',[]), process.env.TAURI_APP_PATH, process.env.TAURI_FRONTEND_PATH, ...process.argv.slice(1)]));`);
  put("ui/node_modules/.bin/tauri", "process.exit(81)", true);
  symlinkSync("secondary", join(workspace.root, "alias"));
  put("host/cc", "console.log('host-compiler')", true);
  put("host/cargo", "console.log('cargo 1.70.0')", true);
  put("host/npm", `
if (process.argv.includes('--versions')) console.log(JSON.stringify({node:process.versions.node,npm:'11.20.0'}));
else if (!process.argv.includes('install')) process.exit(82);`, true);
  put("rust/toolchains/selected/bin/cargo", "console.log('cargo 1.96.0')", true);
  put("rust/toolchains/selected/bin/rustc", "console.log('rustc 1.96.0')", true);
  put("rust/toolchains/selected/bin/cc", "console.log('wrong-rust-compiler')", true);
  put("mise/installs/protobuf/36.2/bin/protoc", "console.log('protoc from mise')", true);
  put("mise/installs/protobuf/36.2/bin/cc", "console.log('wrong-optional-compiler')", true);
  const env = { HOME: root, MISE_DATA_DIR: join(root, "mise"), RUSTUP_HOME: join(root, "rust"), PATH: [join(root, "host"), dirname(process.execPath)].join(delimiter) };
  const w = new Workbench(join(root, "state"), env);
  t.after(() => w.close());
  const target = w.discover(workspace).targets.find(({ adapter, project }) => adapter === "tauri" && project === "secondary");
  assert.ok(target);
  const selected = w.tools(workspace, target).candidates.find(({ paths }) => paths.includes(join(root, "host/npm")) && paths.includes(join(dirname(process.execPath), "node")));
  assert.ok(selected);
  const c = { ...config(w, workspace, target, selected.id), options: ["--config", "overlay.json"] };
  await w.verify(workspace, c);
  const preview = w.preview(workspace, c);
  assert.ok(preview.command.notes?.some((note) => note.includes("TAURI_APP_PATH") && note.includes("secondary")));
  const result = await finish(w, workspace, submit(w, workspace, c).id);
  assert.equal(result.run.status, "success");
  const values = JSON.parse(readFileSync(join(workspace.root, "resolved"), "utf8")) as string[];
  assert.equal(realpathSync(values[0]!), realpathSync(selected.paths[0]!));
  assert.deepEqual(values.slice(1, 6), ["cargo 1.96.0", "host-compiler", "protoc from mise", join(workspace.root, "secondary"), workspace.root]);
  assert.deepEqual(values.slice(6), [cli, "build", "--debug", "--no-bundle", "--config", "overlay.json"]);
  assert.deepEqual(result.run.command?.preparation, preview.command.preparation);
  put("ui/overlay.json", { build: { features: ["different"] } });
  assert.notEqual(w.preview(workspace, c).fingerprint, preview.fingerprint);
  for (const overrides of [{ TAURI_APP_PATH: "src-tauri" }, { TAURI_APP_PATH: "alias" }, { TAURI_FRONTEND_PATH: "../other" }, { TAURI_CONFIG: "{}" }]) {
    const conflict = new Workbench(join(root, "conflict"), { ...env, ...overrides });
    assert.throws(() => conflict.preview(workspace, { ...c, tool: conflict.tools(workspace, target).candidates[0]!.id }), /冲突|TAURI_CONFIG|符号链接/u);
    await conflict.close();
  }
  const allowed = new Workbench(join(root, "relative"), { ...env, TAURI_APP_PATH: "./secondary", TAURI_FRONTEND_PATH: "." });
  assert.ok(allowed.preview(workspace, { ...c, tool: allowed.tools(workspace, target).candidates[0]!.id }));
  await allowed.close();
  put("ui/overlay.json", { build: { runner: "another-cargo" } });
  assert.throws(() => w.preview(workspace, c), /runner/u);
  put("ui/overlay.json", {});
  rmSync(cli);
  const noCli = await finish(w, workspace, submit(w, workspace, c).id);
  assert.match(noCli.run.result ?? "", /仍无法核对所声明的 Tauri CLI/u);
  put("ui/node_modules/@tauri-apps/cli/run.js", "process.exit(0)");
  put("ui/node_modules/.bin/cargo", "process.exit(18)", true);
  const blocked = await finish(w, workspace, submit(w, workspace, c).id);
  assert.equal(blocked.run.status, "failed");
  assert.match(blocked.run.result ?? "", /会覆盖所选 cargo/u);
});
