import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { Configuration, TargetKey } from "../shared/contracts";
import { parseNativeProbe } from "../server/native-projects";
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
  console.log('build - Root build\\nlib:nested:compileKotlin - Compiler task\\nrenderer:createDistributable\\nlib:publish - forbidden\\nrenderer:connectedDebugAndroidTest - forbidden');
} else {
  assert.ok(args.includes(':lib:nested:compileKotlin'));
  fs.mkdirSync('lib/nested/build/libs', { recursive: true });
  fs.writeFileSync('lib/nested/build/libs/fixture.jar', 'jar');
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
  assert.deepEqual((await run(w, workspace, c)).run.confirmedTargets, [":build", build.name, ":renderer:createDistributable"]);
  assert.ok(w.discover(workspace).targets.find((item) => item.name === build.name)?.confirmed);
  assert.ok(!w.discover({ ...workspace, id: "other" }).targets.find((item) => item.name === build.name));
  const detail = await run(w, workspace, configuration(w, workspace, build));
  assert.ok(detail.artifacts.some((a) => a.path.endsWith("fixture.jar") && a.state === "new"));
  const reopened = new Workbench(store, env);
  t.after(() => reopened.close());
  assert.ok(reopened.discover(workspace).targets.find((item) => item.name === build.name)?.confirmed);
  put(workspaceFile("settings.gradle"), settings + "// changed\n");
  assert.ok(!reopened.discover(workspace).targets.find((item) => item.name === build.name));
});

test("Xcode listing and Debug simulator argv keep schemes and artifacts scoped", { skip: process.platform !== "darwin" }, async (t) => {
  const { home, workspace } = fixture(t);
  const developer = join(home, "Fixture.app/Contents/Developer");
  put(join(developer, "usr/bin/xcodebuild"), `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(process.env.DEVELOPER_DIR, ${JSON.stringify(developer)});
if (args.includes('-version')) console.log(args.includes('-sdk') ? '26.1' : 'Xcode 26.1\\nBuild version fixture');
else if (args.includes('-list')) {
  assert.ok(!args.includes('-disableAutomaticPackageResolution'));
  console.log(JSON.stringify({ [args.includes('-project') ? 'project' : 'workspace']: { schemes: ['Fixture', '-invalid', 'Shared from tool'] } }));
}
else {
  const fs = require('node:fs'), path = require('node:path');
  assert.equal(args[args.indexOf('-sdk') + 1], 'iphonesimulator');
  assert.equal(args[args.indexOf('-configuration') + 1], 'Debug');
  assert.ok(args.includes('CODE_SIGNING_ALLOWED=NO') && args.at(-1) === 'build');
  const product = path.join(args[args.indexOf('-derivedDataPath') + 1], 'Build/Products/Debug-iphonesimulator/Fixture.app');
  fs.mkdirSync(product, { recursive: true }); fs.writeFileSync(path.join(product, 'Fixture'), 'simulator');
}
`, true);
  const name = "ios/sample.xcworkspace";
  put(join(workspace.root, name, "contents.xcworkspacedata"), '<FileRef location = "group:sample.xcodeproj"/>');
  put(join(workspace.root, "ios/sample.xcodeproj/project.pbxproj"), "shellScript = ./gradlew generated;");
  const w = new Workbench(join(home, "records"), { DEVELOPER_DIR: developer, HOME: home });
  t.after(() => w.close());
  const probe = configuration(w, workspace, { adapter: "xcode", project: name, name: "list schemes" });
  await w.verify(workspace, probe);
  assert.deepEqual((await run(w, workspace, probe)).run.confirmedTargets, ["Fixture", "Shared from tool"]);
  const standalone = configuration(w, workspace, { ...probe.target, project: "ios/sample.xcodeproj" });
  assert.ok(w.preview(workspace, standalone).command.argv.includes("-project"));
  await w.verify(workspace, standalone);
  assert.deepEqual((await run(w, workspace, standalone)).run.confirmedTargets, ["Fixture", "Shared from tool"]);
  const build = configuration(w, workspace, { ...probe.target, name: "Fixture" });
  assert.throws(() => w.preview(workspace, { ...build, options: ["archive"] }), /不接受额外参数/u);
  assert.ok((await run(w, workspace, build)).artifacts.some((item) => item.path.endsWith("Fixture.app/Fixture") && item.state === "new"));
  assert.deepEqual(parseNativeProbe("xcode", '{"workspace":{}}'), []);
  assert.throws(() => parseNativeProbe("xcode", '{"other":{}}'), /无法读取/u);
});
