import { createHash } from "node:crypto";
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

test("Gradle wrapper cache, JDK, SDK and explicit task probe", { skip: process.platform === "win32" }, async (t) => {
  const { home, workspace } = fixture(t);
  const workspaceFile = (name: string) => join(workspace.root, name);
  const distribution = "https://services.gradle.org/distributions/gradle-9.5.1-all.zip";
  const settings = 'include(":mobile")\ninclude(":desktop")\n';
  put(workspaceFile("settings.gradle.kts"), settings);
  put(workspaceFile("mobile/build.gradle.kts"), 'plugins { id("com.android.application") }');
  put(workspaceFile("desktop/build.gradle.kts"), "compose.desktop { application {} }");
  put(workspaceFile("gradle/libs.versions.toml"), '[versions]\nandroid_sdk_compile = "36"');
  put(workspaceFile("gradle/wrapper/gradle-wrapper.properties"), `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\ndistributionUrl=${distribution}\n`);
  put(workspaceFile("gradle/wrapper/gradle-wrapper.jar"), "fixture, not executed");
  const javaHome = join(home, "jdk");
  put(join(javaHome, "bin/java"), 'console.log("openjdk 17.0.21");', true);
  put(workspaceFile("gradlew"), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(process.env.JAVA_HOME, ${JSON.stringify(javaHome)});
assert.ok(args.includes('--offline') && args.includes('--no-daemon') && args.includes('-Dorg.gradle.native=false'));
if (args.includes('--version')) {
  console.log('Gradle 9.5.1\\nLauncher JVM: 17.0.21 (Fixture)\\nDaemon JVM: ' + process.env.JAVA_HOME + ' (forced)');
} else if (args.includes('tasks')) {
  fs.writeFileSync('probe-ran', 'yes');
  console.log('mobile:assembleDebug - Assemble debug\\n:desktop:createDistributable\\nmobile:publish - forbidden');
} else {
  assert.ok(args.includes(':mobile:assembleDebug'));
  fs.mkdirSync('mobile/build/outputs/apk/debug', { recursive: true });
  fs.writeFileSync('mobile/build/outputs/apk/debug/fixture.apk', 'apk');
}
`, true);
  const env = { PATH: [join(javaHome, "bin"), dirname(process.execPath)].join(delimiter), JAVA_HOME: javaHome, GRADLE_USER_HOME: join(home, "gradle-home"), ANDROID_HOME: join(home, "sdk"), HOME: home };
  const store = join(home, "records");
  const w = new Workbench(store, env);
  t.after(() => w.close());
  const probe: TargetKey = { adapter: "gradle", project: ".", name: "tasks --all" };
  const build: TargetKey = { ...probe, name: ":mobile:assembleDebug" };
  assert.deepEqual(w.discover(workspace).targets.map((item) => item.name), [probe.name, build.name, ":desktop:createDistributable"]);
  assert.equal(existsSync(workspaceFile("probe-ran")), false);
  const blocked = configuration(w, workspace, probe);
  assert.match(w.tools(workspace, probe).issues.join(), /Android SDK platform android-36/u);
  await assert.rejects(w.verify(workspace, blocked), /Wrapper 缓存/u);
  const hash = BigInt("0x" + createHash("md5").update(distribution).digest("hex")).toString(36);
  const cache = join(env.GRADLE_USER_HOME, "wrapper/dists/gradle-9.5.1-all", hash);
  put(join(cache, "gradle-9.5.1-all.zip.ok"), "");
  put(join(cache, "gradle-9.5.1/bin/gradle"), 'throw new Error("not executed directly")', true);
  put(join(cache, "gradle-9.5.1/lib/gradle-launcher-9.5.1.jar"), "");
  await assert.rejects(w.verify(workspace, configuration(w, workspace, probe)), /Android SDK platform android-36/u);
  put(join(env.ANDROID_HOME, "platforms/android-36/android.jar"), "");
  const c = configuration(w, workspace, probe);
  assert.match((await w.verify(workspace, c)).version ?? "", /Launcher\/daemon JDK 17 · Android SDK 36/u);
  assert.deepEqual((await run(w, workspace, c)).run.confirmedTargets, [build.name, ":desktop:createDistributable"]);
  assert.ok(w.discover(workspace).targets.find((item) => item.name === build.name)?.confirmed);
  assert.ok(!w.discover({ ...workspace, id: "other" }).targets.find((item) => item.name === build.name)?.confirmed);
  const detail = await run(w, workspace, configuration(w, workspace, build));
  assert.ok(detail.artifacts.some((a) => a.path.endsWith("fixture.apk") && a.state === "new"));
  const reopened = new Workbench(store, env);
  t.after(() => reopened.close());
  assert.ok(reopened.discover(workspace).targets.find((item) => item.name === build.name)?.confirmed);
  put(workspaceFile("settings.gradle.kts"), settings + "// changed\n");
  assert.ok(!reopened.discover(workspace).targets.find((item) => item.name === build.name)?.confirmed);
});

test("Xcode listing and Debug simulator argv keep schemes and artifacts scoped", { skip: process.platform !== "darwin" }, async (t) => {
  const { home, workspace } = fixture(t);
  const developer = join(home, "Fixture.app/Contents/Developer");
  put(join(developer, "usr/bin/xcodebuild"), `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(process.env.DEVELOPER_DIR, ${JSON.stringify(developer)});
if (args.includes('-version')) console.log(args.includes('-sdk') ? '26.1' : 'Xcode 26.1\\nBuild version fixture');
else if (args.includes('-list')) console.log(JSON.stringify({ workspace: { schemes: ['Fixture', '-invalid', 'undeclared'] } }));
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
  put(join(workspace.root, "ios/sample.xcodeproj/project.pbxproj"), "project");
  put(join(workspace.root, "ios/sample.xcodeproj/xcshareddata/xcschemes/Fixture.xcscheme"), "<Scheme><BuildAction /></Scheme>");
  const w = new Workbench(join(home, "records"), { DEVELOPER_DIR: developer, HOME: home });
  t.after(() => w.close());
  const probe = configuration(w, workspace, { adapter: "xcode", project: name, name: "list schemes" });
  await w.verify(workspace, probe);
  assert.deepEqual((await run(w, workspace, probe)).run.confirmedTargets, ["Fixture"]);
  const build = configuration(w, workspace, { ...probe.target, name: "Fixture" });
  assert.throws(() => w.preview(workspace, { ...build, options: ["archive"] }), /不接受额外参数/u);
  assert.ok((await run(w, workspace, build)).artifacts.some((item) => item.path.endsWith("Fixture.app/Fixture") && item.state === "new"));
  assert.throws(() => parseNativeProbe("xcode", '{"workspace":{}}'), /无法读取/u);
});
