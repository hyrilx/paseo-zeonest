import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gradleJvmOverride, gradleRuntime, javaRelease, wrapperVersion } from "../server/gradle-runtime";
import { gradleOptions } from "../server/options";
import { workspaceRoot } from "../server/paths";

test("only unambiguous official Wrapper distributions yield a version", () => {
  const props = "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.5.1-bin.zip";
  assert.equal(wrapperVersion(props), "9.5.1");
  assert.equal(wrapperVersion(props.replace("9.5.1-bin", "8.5-all")), "8.5");
  assert.equal(wrapperVersion(props.replace("services.gradle.org", "example.test")), undefined);
  assert.equal(wrapperVersion(props.replace("9.5.1", "9.6-rc-1")), undefined);
  assert.equal(wrapperVersion(props + "\ndistributionUrl = alternate"), undefined);
  assert.equal(wrapperVersion(props + "\ndistribution\\Url = alternate"), undefined);
});

test("Wrapper launcher Java is not proof of a supported Gradle runtime", () => {
  assert.deepEqual(gradleRuntime("9.5.1", "1.8.0_514"), {
    status: "incompatible", reason: "Gradle 9.5.1 的运行 JVM 要求 Java 17–26；启动 Java 1.8.0_514 不在范围内。",
  });
  assert.equal(gradleRuntime("9.5.1", "17.0.21.1").status, "compatible");
  assert.equal(gradleRuntime("9.5.1", "26.0.1").status, "compatible");
  assert.equal(gradleRuntime("8.5", "22.0.1").status, "incompatible");
  assert.equal(gradleRuntime("9.5.1", "27-ea+1").status, "unknown");
  assert.equal(gradleRuntime("9.6.0", "17.0.21.1").status, "unknown");
  assert.equal(gradleRuntime(undefined, "17.0.21.1").status, "unknown");
  assert.equal(gradleRuntime("9.5.1", undefined).status, "unknown");
  assert.equal(gradleRuntime("9.5.1", "1.8.0_514", "项目声明了 daemon JVM criteria").status, "unknown");
});

test("override evidence is read without choosing a project JDK", (t) => {
  const root = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-gradle-runtime-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const userHome = join(root, "user");
  const project = join(root, "project");
  mkdirSync(userHome);
  mkdirSync(join(project, "gradle"), { recursive: true });
  writeFileSync(join(userHome, "release"), 'JAVA_VERSION="17.0.21.1"\n');
  assert.equal(javaRelease(userHome), "17.0.21.1");
  writeFileSync(join(project, "gradle.properties"), "org.gradle.jvmargs=-Xmx6144m\n");
  const check = (env: NodeJS.ProcessEnv = {}) => gradleJvmOverride(root, "project", userHome, env);
  assert.equal(check(), undefined);
  assert.match(check({ GRADLE_OPTS: "-Dorg.gradle.java.home=/external" }) ?? "", /宿主环境/u);
  writeFileSync(join(userHome, "gradle.properties"), "org.gradle.java.home=/external\n");
  assert.match(check() ?? "", /用户 Gradle 属性/u);
  writeFileSync(join(project, "gradle.properties"), "org.gradle.java.home=/external\n");
  assert.match(check() ?? "", /项目 Gradle 属性/u);
  writeFileSync(join(project, "gradle/gradle-daemon-jvm.properties"), "toolchainVersion=21\n");
  assert.match(check() ?? "", /daemon JVM criteria/u);
  assert.throws(() => gradleOptions(["-Dgradle.user.home=/other"], true));
});
