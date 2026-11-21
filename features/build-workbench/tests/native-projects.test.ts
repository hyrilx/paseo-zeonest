import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { PROBE_TARGET_LIMIT, WORKSPACE_TARGET_LIMIT, type Configuration, type TargetKey } from "../shared/contracts";
import { gradleProbe, parseXcodeProbe } from "../server/native-projects";
import { workspaceRoot } from "../server/paths";
import { Workbench } from "../server/workbench";

function fixture(t: TestContext) {
  const home = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-native-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "workspace");
  mkdirSync(root);
  return { home, workspace: { id: "native-fixture", root } };
}
function put(filename: string, content: string, executable = false) {
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, executable ? `#!${process.execPath}\n${content}` : content, { mode: executable ? 0o700 : 0o600 });
}
function configuration(w: Workbench, workspace: ReturnType<typeof fixture>["workspace"], target: TargetKey): Configuration {
  const tool = w.tools(workspace, target).candidates[0];
  assert.ok(tool);
  return { target, tool: tool.id, options: [], artifacts: [] };
}
async function run(w: Workbench, workspace: ReturnType<typeof fixture>["workspace"], c: Configuration) {
  const submitted = w.start(workspace, c, w.preview(workspace, c).fingerprint);
  assert.equal(submitted.kind, "started");
  for (let i = 0; i < 120; i++) {
    const detail = w.detail(workspace, submitted.run.id, 0);
    if (detail.run.endedAt) {
      assert.equal(detail.run.status, "success", JSON.stringify(detail));
      return detail;
    }
    await wait(25);
  }
  assert.fail("fixture process did not exit");
}

test("Gradle first probe prepares a cold Wrapper and discovers native tasks without static conventions", { skip: process.platform === "win32" }, async (t) => {
  const { home, workspace } = fixture(t);
  const workspaceFile = (name: string) => join(workspace.root, name);
  const settings = "include 'lib:nested', 'renderer'\n";
  put(workspaceFile("settings.gradle"), settings);
  put(workspaceFile("lib/nested/build.gradle"), "plugins { id 'java' }");
  put(workspaceFile("gradle/gradle-daemon-jvm.properties"), "toolchainVersion=21");
  put(workspaceFile("local.properties"), "sdk.dir=/different/path");
  put(workspaceFile("gradle/wrapper/gradle-wrapper.properties"), "distributionUrl=https://mirror.example/gradle-custom.zip\n");
  put(workspaceFile("gradle/wrapper/gradle-wrapper.jar"), "fixture");
  const javaHome = join(home, "jdk");
  put(join(javaHome, "bin/java"), 'process.stderr.write("openjdk version \\"21.0.1\\"");', true);
  put(workspaceFile("gradlew"), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(process.env.JAVA_HOME, ${JSON.stringify(javaHome)});
assert.ok(args.includes('--no-daemon') && !args.includes('--offline'));
assert.match(process.env.JAVA_TOOL_OPTIONS, /org.gradle.native=false/);
if (args.includes('tasks')) {
  fs.writeFileSync('probe-ran', 'first Wrapper download and project settings');
  const variant = args.includes('-PsampleFeature=two words') ? 'renderer:assembleDemoRelease\\n' : '';
  console.log('Build tasks\\n-----------\\nbuild - Root build\\nlib:nested:compileKotlin - Compiler task\\nrenderer:createDistributable\\n' + variant + 'renderer:shadowJar\\nrenderer:dockerPush\\nData preparation tasks\\n-----------\\nrenderer:renderAssets\\nVerification tasks\\n-----------\\nrenderer:testDemoReleaseUnitTest\\nPublishing tasks\\n-----------\\nlib:publish - forbidden\\nrenderer:connectedDebugAndroidTest - forbidden');
} else {
  assert.ok(args.includes(':lib:nested:compileKotlin'));
  assert.ok(args.includes('--max-workers') && args.includes('-PsampleFeature=two words'));
  assert.ok(!args.some((arg) => arg.startsWith('-Pkotlin.compiler.execution.strategy=')));
  fs.mkdirSync('sources/renderer/produced', { recursive: true });
  fs.writeFileSync('sources/renderer/produced/fixture.jar', 'jar');
}
`, true);
  const env = { PATH: [join(javaHome, "bin"), dirname(process.execPath)].join(delimiter), JAVA_HOME: javaHome, GRADLE_USER_HOME: join(home, "cold-gradle-home"), HOME: home };
  const store = join(home, "records");
  const w = new Workbench(store, env);
  t.after(() => w.close());
  const probe: TargetKey = { adapter: "gradle", project: ".", name: "tasks --all" };
  const build: TargetKey = { ...probe, name: ":lib:nested:compileKotlin" };
  assert.deepEqual(w.discover(workspace).targets.map((item) => item.name), [probe.name]);
  const c = configuration(w, workspace, probe);
  assert.match((await w.verify(workspace, c)).version ?? "", /openjdk version "21\.0\.1"/u);
  assert.equal(existsSync(workspaceFile("probe-ran")), false, "verification must not execute the Wrapper");
  assert.deepEqual((await run(w, workspace, c)).run.confirmedTargets, [":build", build.name, ":renderer:createDistributable", ":renderer:shadowJar", ":renderer:renderAssets", ":renderer:testDemoReleaseUnitTest"]);
  assert.ok(w.discover(workspace).targets.find((item) => item.name === build.name)?.confirmed);
  assert.ok(!w.discover({ ...workspace, id: "other" }).targets.some((item) => item.name === build.name));
  const variant = ":renderer:assembleDemoRelease";
  const property = "-PsampleFeature=two words";
  const buildConfig = { ...configuration(w, workspace, build), options: ["--max-workers", "2", property], artifacts: ["sources/renderer/produced"] };
  assert.throws(() => w.preview(workspace, buildConfig), /未确认此目标/u);
  assert.ok((await run(w, workspace, { ...c, options: buildConfig.options })).run.confirmedTargets?.includes(variant));
  const variantTarget = { ...build, name: variant };
  assert.throws(() => w.preview(workspace, { ...buildConfig, target: variantTarget, options: [] }), /未确认此目标/u);
  assert.deepEqual(w.discover(workspace).targets.find((item) => item.name === variant)?.probeOptions, buildConfig.options);
  assert.throws(() => w.preview(workspace, { ...buildConfig, options: [":renderer:publish"] }), /不支持选项/u);
  const detail = await run(w, workspace, buildConfig);
  assert.ok(detail.artifacts.some((a) => a.path.endsWith("fixture.jar") && a.state === "new"));
  const reopened = new Workbench(store, env);
  t.after(() => reopened.close());
  assert.ok(!reopened.discover(workspace).targets.some((item) => item.name === build.name));
  put(workspaceFile("settings.gradle"), settings + "// changed\n");
  assert.ok(!reopened.discover(workspace).targets.find((item) => item.name === build.name));
});

test("Gradle parser reads split headings, CRLF, split task paths and the final unterminated line", () => {
  const parser = gradleProbe();
  for (const chunk of ["Unrelated output\nBuild ta", "sks\r", "\n-------\r\nlib:compile", "Kotlin - Compiles tasks\r\n", "badName - " + "a".repeat(17 * 1024), "\r\napp:asse", "mbleDebug"]) parser.push(chunk);
  assert.deepEqual(parser.finish(), { names: [":lib:compileKotlin", ":app:assembleDebug"], limited: true });
  const noise = gradleProbe();
  for (let i = 0; i < 400; i++) noise.push("Configuration message: " + "x".repeat(700) + "\n");
  noise.push("Build tasks\n-----------\napp:assembleDebug\n");
  assert.deepEqual(noise.finish(), { names: [":app:assembleDebug"], limited: false });
  const invalid = gradleProbe();
  invalid.push("Build tasks\nwithout a task section\nBUILD SUCCESSFUL");
  assert.throws(() => invalid.finish(), /没有返回可识别的任务列表/u);
});

test("long Gradle probes keep late build entries beyond log and target limits; only successful probes replace the list", { skip: process.platform === "win32" }, async (t) => {
  const { home, workspace } = fixture(t);
  const file = (name: string) => join(workspace.root, name);
  put(file("settings.gradle"), "include 'app', 'desktop-app'\n");
  for (const project of ["app", "desktop-app"]) put(file(project + "/build.gradle"), "// fixture");
  put(file("package.json"), JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: WORKSPACE_TARGET_LIMIT + 1 }, (_, i) => ["script" + i, "fixture"])) }));
  const distro = join(home, "gradle");
  put(join(distro, "lib/gradle-launcher-9.5.1.jar"), "fixture");
  const javaHome = join(home, "jdk");
  for (const path of ["release", "lib/modules", "lib/server/libjvm.so"]) put(join(javaHome, path), "fixture");
  put(join(javaHome, "bin/java"), 'process.stderr.write("openjdk version \\"21.0.1\\"");', true);
  put(join(distro, "bin/gradle"), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.ok(process.argv.includes('tasks') && process.argv.includes('--all'));
const mode = fs.existsSync('mode') ? fs.readFileSync('mode', 'utf8') : 'large';
if (mode === 'invalid') console.log('BUILD SUCCESSFUL but no tasks listing');
else if (mode === 'large') {
  fs.writeSync(1, 'Build tasks\\r\\n-----------\\r\\n');
  for (let i = 0; i < 600; i++) {
    const task = i % 2 ? 'bundleDebugResources' : 'allMetadataJar';
    fs.writeSync(1, 'module' + i + ':' + task + ' - ' + 'x'.repeat(700) + '\\r\\n');
  }
  fs.writeSync(1, 'Compose desktop tasks\\r\\n---------------------\\r\\ndesktop-app:createDistributable\\r\\n');
  fs.writeSync(1, 'Other tasks\\r\\n-----------\\r\\napp:assembleDebug\\r\\napp:publishDebug\\r\\napp:installDebug\\r\\napp:signDebug\\r\\n');
  fs.writeSync(1, 'app:assembleDebug - Assembles main output for variant debug');
} else {
  fs.writeSync(1, 'Build tasks\\n-----------\\napp:assembleReplacement\\n');
  if (mode === 'failure') process.exitCode = 9;
  if (mode === 'stop') setInterval(() => {}, 100);
}
`, true);
  const store = join(home, "records");
  const env = { PATH: [join(distro, "bin"), join(javaHome, "bin"), dirname(process.execPath)].join(delimiter), JAVA_HOME: javaHome, HOME: home };
  const w = new Workbench(store, env);
  t.after(() => w.close());
  const key = { adapter: "gradle", project: ".", name: "tasks --all" } as const;
  const c = configuration(w, workspace, key);
  await w.verify(workspace, c);
  async function probe(mode: string) {
    put(file("mode"), mode);
    const submitted = w.start(workspace, c, w.preview(workspace, c).fingerprint);
    assert.equal(submitted.kind, "started");
    let stopped = false;
    for (let i = 0; i < 120; i++) {
      const detail = w.detail(workspace, submitted.run.id, 0);
      if (detail.run.endedAt) return detail;
      if (mode === "stop" && !stopped && detail.rows.some((row) => row.text.includes("assembleReplacement"))) {
        w.stop(workspace, submitted.run.id);
        stopped = true;
      }
      await wait(25);
    }
    assert.fail("Gradle fixture did not finish");
  }
  const first = await probe("failure");
  assert.equal(first.run.status, "failed");
  assert.equal(first.run.confirmedTargets, undefined);
  assert.ok(!w.discover(workspace).targets.some((target) => target.confirmed));
  const report = await probe("large");
  assert.equal(report.run.status, "success");
  assert.equal(report.truncated, true, "UI log cap is independent of the parser");
  assert.equal(report.run.confirmedTargetsLimited, true);
  assert.equal(report.run.confirmedTargets?.length, PROBE_TARGET_LIMIT);
  assert.equal(report.run.confirmedTargets?.[0], ":module0:allMetadataJar");
  assert.ok(!report.run.confirmedTargets?.includes(":module599:bundleDebugResources"));
  const names = [":desktop-app:createDistributable", ":app:assembleDebug"];
  assert.deepEqual(report.run.confirmedTargets?.slice(-2), names);
  for (const [mode, status] of [["failure", "failed"], ["invalid", "failed"], ["stop", "stopped"]] as const) {
    const rejected = await probe(mode);
    assert.equal(rejected.run.status, status);
    assert.equal(rejected.run.confirmedTargets, undefined);
    assert.ok(w.discover(workspace).targets.some(({ name, confirmed }) => name === names[0] && confirmed));
  }
  await w.close();
  const reopened = new Workbench(store, env);
  t.after(() => reopened.close());
  const refreshed = reopened.discover(workspace);
  assert.equal(refreshed.targets.length, WORKSPACE_TARGET_LIMIT);
  assert.ok(refreshed.notices.some((notice) => notice.includes("探测结果有截断")));
  assert.ok(refreshed.notices.some((notice) => notice.includes("工作区仅显示")));
  assert.ok(!refreshed.targets.some(({ name }) => /assembleReplacement|publishDebug|installDebug|signDebug/u.test(name)));
  put(file("mode"), "large");
  const filtered = { ...configuration(reopened, workspace, key), options: ["--workbench-task-filter=:module599:"] };
  await reopened.verify(workspace, filtered);
  const restricted = await run(reopened, workspace, filtered);
  assert.deepEqual(restricted.run.confirmedTargets, [":module599:bundleDebugResources"]);
  const shared = reopened.discover({ ...workspace, id: "filtered-reader" });
  assert.ok(shared.targets.some(({ name }) => name === ":module599:bundleDebugResources"));
  assert.ok(shared.targets.some(({ name }) => name === ":app:assembleDebug"));
  assert.ok(shared.notices.some((notice) => notice.includes("探测结果有截断")));
  for (const name of names) {
    const target = refreshed.targets.find((target) => target.name === name && target.confirmed);
    assert.ok(target);
    const config = configuration(reopened, workspace, target);
    assert.deepEqual(reopened.preview(workspace, config).command.argv.slice(1), ["--no-daemon", "--console=plain", name]);
  }
});

test("Xcode listing and selectable simulator configuration keep schemes and artifacts scoped", { skip: process.platform !== "darwin" }, async (t) => {
  const { home, workspace } = fixture(t);
  const developer = join(home, "Fixture.app/Contents/Developer");
  put(join(developer, "usr/bin/xcodebuild"), `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(process.env.DEVELOPER_DIR, ${JSON.stringify(developer)});
if (args.includes('-version')) console.log(args.includes('-sdk') ? '26.1' : 'Xcode 26.1\\nBuild version fixture');
else if (args.includes('-list')) {
  assert.ok(!args.includes('-disableAutomaticPackageResolution'));
  if (require('node:fs').existsSync('large-xcode-probe')) console.log('x'.repeat(256 * 1024));
  console.log(JSON.stringify({ [args.includes('-project') ? 'project' : 'workspace']: { schemes: ['Fixture', '-invalid', 'Shared from tool'] } }));
}
else {
  const fs = require('node:fs'), path = require('node:path');
  assert.equal(args[args.indexOf('-sdk') + 1], 'iphonesimulator');
  const configuration = args[args.indexOf('-configuration') + 1];
  assert.equal(configuration, 'Custom Release');
  assert.ok(args.includes('CODE_SIGNING_ALLOWED=NO') && args.at(-1) === 'build');
  const product = path.join(args[args.indexOf('-derivedDataPath') + 1], 'Build/Products/' + configuration + '-iphonesimulator/Fixture.app');
  fs.mkdirSync(product, { recursive: true }); fs.writeFileSync(path.join(product, 'Fixture'), 'simulator');
}
`, true);
  const name = "ios/sample.xcworkspace";
  put(join(workspace.root, name, "contents.xcworkspacedata"), '<FileRef location = "group:sample.xcodeproj"/>');
  put(join(workspace.root, "ios/sample.xcodeproj/project.pbxproj"), "shellScript = ./gradlew generated;");
  const alt = join(home, "Applications/Xcode-Beta.app/Contents/Developer/usr/bin/xcodebuild");
  put(alt, 'console.log("Xcode Beta");', true);
  const w = new Workbench(join(home, "records"), { DEVELOPER_DIR: developer, HOME: home });
  t.after(() => w.close());
  const probe = configuration(w, workspace, { adapter: "xcode", project: name, name: "list schemes" });
  assert.ok(w.tools(workspace, probe.target).candidates.some((tool) => tool.paths.includes(alt)));
  await w.verify(workspace, probe);
  assert.deepEqual((await run(w, workspace, probe)).run.confirmedTargets, ["Fixture", "Shared from tool"]);
  const standalone = configuration(w, workspace, { ...probe.target, project: "ios/sample.xcodeproj" });
  assert.ok(w.preview(workspace, standalone).command.argv.includes("-project"));
  await w.verify(workspace, standalone);
  assert.deepEqual((await run(w, workspace, standalone)).run.confirmedTargets, ["Fixture", "Shared from tool"]);
  const build = configuration(w, workspace, { ...probe.target, name: "Fixture" });
  assert.throws(() => w.preview(workspace, { ...build, options: ["archive"] }), /不支持选项/u);
  assert.throws(() => w.preview(workspace, { ...build, options: ["CODE_SIGNING_ALLOWED=YES"] }), /不支持选项/u);
  assert.ok(!w.preview(workspace, build).command.argv.includes("-configuration"), "leave the scheme default alone");
  const other = w.tools(workspace, build.target).candidates.find(({ paths }) => paths.includes(alt));
  assert.ok(other);
  assert.throws(() => w.preview(workspace, { ...build, tool: other.id }), /未确认此目标/u);
  const configured = { ...build, options: ["-configuration", "Custom Release"] };
  const argv = w.preview(workspace, configured).command.argv;
  const derived = argv[argv.indexOf("-derivedDataPath") + 1]!.slice(workspace.root.length + 1);
  assert.throws(() => w.preview(workspace, { ...configured, artifacts: [".zeonest-build"] }), /隐藏目录/u);
  const product = derived + "/Build/Products/Custom Release-iphonesimulator/Fixture.app";
  const observed = await run(w, workspace, { ...configured, artifacts: [product] });
  assert.ok(observed.artifacts.some(({ path, state, origin }) => path.endsWith("Fixture.app/Fixture") && state === "new" && !origin));
  put(join(workspace.root, "ios/large-xcode-probe"), "");
  const oversized = w.start(workspace, probe, w.preview(workspace, probe).fingerprint);
  assert.equal(oversized.kind, "started");
  for (let i = 0; i < 120 && !w.detail(workspace, oversized.run.id, 0).run.endedAt; i++) await wait(25);
  const rejected = w.detail(workspace, oversized.run.id, 0).run;
  assert.equal(rejected.status, "failed");
  assert.match(rejected.result ?? "", /探测输出超过读取上限/u);
  assert.equal(rejected.confirmedTargets, undefined);
  assert.ok(w.discover(workspace).targets.some((item) => item.project === name && item.name === "Fixture" && item.confirmed));
  put(join(workspace.root, name, "xcshareddata/xcschemes/Fixture.xcscheme"), "<Scheme/>");
  assert.ok(!w.discover(workspace).targets.some((item) => item.project === name && item.name === "Fixture"));
  assert.deepEqual(parseXcodeProbe('{"workspace":{}}'), { names: [], limited: false });
  assert.throws(() => parseXcodeProbe('{"other":{}}'), /无法读取/u);
});
