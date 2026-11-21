import { accessSync, constants, lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Candidate, Configuration } from "../shared/contracts";
import { digest, resolveWithin } from "./paths";
import { gradleCache } from "./native-projects";
import { launch } from "./process";
import type { Invocation, OwnedProcess } from "./process";
import type { ProjectTarget } from "./projects";

export type Tool = { candidate: Candidate; signature: string; executable: string; env: NodeJS.ProcessEnv };
export type Checks = Map<string, string>;

export function executables(name: string, env: NodeJS.ProcessEnv) {
  const paths = new Set<string>();
  for (const dir of (env.PATH ?? "").split(delimiter).filter(isAbsolute).slice(0, 64)) {
    try {
      const path = resolve(dir, name);
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) paths.add(path);
    } catch { /* PATH entries need not exist on this host. */ }
  }
  return [...paths].slice(0, 10);
}

export function identity(path: string) {
  const s = statSync(path, { bigint: true });
  return [path, realpathSync(path), s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}

export function requirement(t: ProjectTarget) {
  if (t.xcode) return `完整 Xcode · iPhone Simulator SDK${t.gradle && !t.operation ? " · 已缓存 Gradle Wrapper · JDK 17" : ""}`;
  if (t.gradle) return `已缓存 Gradle Wrapper ${t.gradle.version} · JDK 17${t.gradle.usesAndroid ? " · Android SDK " + (t.gradle.android ?? "（版本未确认）") : ""}`;
  if (t.cmake) return "CMake ≥ 3.14 · Ninja · C/C++ 编译器（项目在配置时检查）";
  if (t.tauri) return `${jsRequirement(t, "pnpm")} · Cargo/rustc · macOS SDK · 项目内 Tauri CLI`;
  if (t.adapter === "cargo") return `Cargo + rustc${t.requirements.protoc ? " · protoc" : ""}${t.requirements.rustChannel ? " · " + t.requirements.rustChannel : ""}${t.requirements.rust ? " · Rust >=" + t.requirements.rust : ""}`;
  return jsRequirement(t, t.adapter);
}

function jsRequirement(t: ProjectTarget, manager: string) {
  return `Node ${[t.requirements.miseNode, t.requirements.node].filter(Boolean).join(" 且 ") || "（项目未指定版本）"} · ${manager} ${[t.requirements.manager, t.requirements.managerEngine].filter(Boolean).join(" 且 ") || "（项目未指定版本）"}`;
}

function makeTool(t: ProjectTarget, checked: Checks, paths: string[], executable: string, env: NodeJS.ProcessEnv, label: string): Tool {
  const id = digest(JSON.stringify(paths)).slice(0, 32);
  const signature = digest(JSON.stringify([t.requirements, t.gradle, t.xcode, env.JAVA_HOME, env.ANDROID_HOME, env.DEVELOPER_DIR, ...paths.map(identity)]));
  return { candidate: { id, paths, label, requirement: requirement(t), version: checked.get(signature) }, executable, env, signature };
}

function installedDirs(root: string) {
  const found: string[] = [];
  try {
    const dir = opendirSync(root);
    try { for (let i = 0, entry; i < 64 && (entry = dir.readSync()); i++) if (entry.isDirectory() && !entry.name.startsWith(".")) found.push(join(root, entry.name)); }
    finally { dir.closeSync(); }
  } catch { /* Installation directories are optional. */ }
  return found;
}

function installedExecutables(name: string, env: NodeJS.ProcessEnv, preferred?: string) {
  const home = env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local/share"), "mise");
  const versionRoot = join(home, "installs", name);
  const known = installedDirs(versionRoot);
  const priority = preferred && /^[\w.-]+$/u.test(preferred) ? [join(versionRoot, preferred)] : [];
  const dirs = [...priority, ...known].flatMap((p) => [join(p, "bin"), p]);
  return executables(name, { PATH: [ ...priority.flatMap((p) => [join(p, "bin"), p]), env.PATH ?? "", ...dirs ].join(delimiter) });
}

function rustPairs(t: ProjectTarget, env: NodeJS.ProcessEnv) {
  const rust = env.RUSTUP_HOME ?? join(env.HOME ?? homedir(), ".rustup");
  const dirs = [...installedDirs(join(rust, "toolchains")).map((p) => join(p, "bin")), ...(env.PATH ?? "").split(delimiter)];
  return executables("cargo", { PATH: dirs.join(delimiter) }).flatMap((cargo) => {
    const bin = dirname(cargo);
    const rustc = executables("rustc", { PATH: bin })[0];
    const channel = dirname(bin).split("/").at(-1) ?? "";
    if (!rustc || [cargo, rustc].some((p) => realpathSync(p).endsWith("/rustup") || autoInstallRisk(p))) return [];
    if (t.requirements.rustChannel && channel !== t.requirements.rustChannel && !channel.startsWith(t.requirements.rustChannel + "-")) return [];
    return [{ cargo, rustc, bin }];
  });
}

function androidState(t: ProjectTarget, env: NodeJS.ProcessEnv) {
  if (!t.gradle?.usesAndroid) return {};
  const version = t.gradle.android;
  if (!version) return { issue: "无法从版本目录确认 Android compileSdk" };
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? join(env.HOME ?? homedir(), "Library/Android/sdk");
  try {
    if (!isAbsolute(sdk) || !statSync(join(sdk, "platforms", `android-${version}`, "android.jar")).isFile()) throw new Error("缺少 android.jar");
    return { sdk };
  } catch { return { issue: `缺少 Android SDK platform android-${version}（${sdk}）` }; }
}

function xcodeExecutable(env: NodeJS.ProcessEnv) {
  if (process.platform !== "darwin") return undefined;
  const selected = env.DEVELOPER_DIR;
  const dirs = selected ? [selected.endsWith(".app") ? join(selected, "Contents/Developer") : selected]
    : ["/Applications/Xcode.app/Contents/Developer"];
  return executables("xcodebuild", { PATH: dirs.map((d) => join(d, "usr/bin")).join(delimiter) })[0];
}

const xcodeDeveloperDir = (executable: string) => dirname(dirname(dirname(executable)));

export function toolIssues(t: ProjectTarget, env: NodeJS.ProcessEnv) {
  const issues: string[] = [];
  if (t.blocked) issues.push(t.blocked);
  if (t.xcode && !xcodeExecutable(env)) issues.push("没有找到完整 Xcode；仅安装 Command Line Tools 无法构建 iPhone Simulator 产物。");
  if (t.gradle && !(t.xcode && t.operation)) {
    if (!gradleCache(t.gradle, env)) issues.push(`没有已解压的 Gradle ${t.gradle.version} Wrapper 缓存。检查不会触发下载。`);
    const { issue } = androidState(t, env);
    if (issue) issues.push(issue);
  }
  return issues;
}

function nativeTools(t: ProjectTarget, env: NodeJS.ProcessEnv, checked: Checks, root: string): Tool[] {
  const xcode = t.xcode && xcodeExecutable(env);
  if (t.xcode && !xcode) return [];
  if (!t.gradle || (xcode && t.operation === "probe")) {
    return xcode ? [makeTool(t, checked, [xcode], xcode, { ...env, DEVELOPER_DIR: xcodeDeveloperDir(xcode) }, `Xcode · ${xcode}`)] : [];
  }
  const { sdk } = androidState(t, env);
  const cache = gradleCache(t.gradle, env);
  const preferred = env.JAVA_HOME && isAbsolute(env.JAVA_HOME) ? executables("java", { PATH: join(env.JAVA_HOME, "bin") }) : [];
  const javaExecutables = [...new Set([...installedExecutables("java", env, "temurin-17"), ...preferred])].filter((p) => p !== "/usr/bin/java" && !autoInstallRisk(p));
  const wrapper = resolveWithin(root, t.gradle.wrapper);
  const wrapperJar = resolveWithin(root, `${t.cwd === "." || t.xcode ? "" : t.cwd + "/"}gradle/wrapper/gradle-wrapper.jar`);
  return javaExecutables.map((java) => {
    const javaHome = dirname(dirname(realpathSync(java)));
    // Native Gradle daemons detach via maybeDetachProcess(), even when single-use.
    // Disable native integration in both the launcher and any forked JVM.
    if (/["\r\n]/u.test(javaHome)) throw new Error("JDK 路径包含 JVM 选项无法安全表示的字符");
    const runEnv = { ...env, JAVA_HOME: javaHome, PATH: [join(javaHome, "bin"), env.PATH ?? ""].join(delimiter),
      GRADLE_OPTS: ["-Dorg.gradle.daemon=false", "-Dorg.gradle.native=false", "-Dorg.gradle.project.org.gradle.java.installations.auto-download=false",
        "-Dorg.gradle.project.android.builder.sdkDownload=false", "-Dorg.gradle.project.kotlin.compiler.execution.strategy=in-process"].join(" "),
      JAVA_OPTS: "", JDK_JAVA_OPTIONS: "", _JAVA_OPTIONS: "", JAVA_TOOL_OPTIONS: `-Dorg.gradle.native=false "-Dorg.gradle.java.home=${javaHome}"`,
      ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}), ...(cache ? { GRADLE_USER_HOME: cache.home } : {}),
      ...(xcode ? { DEVELOPER_DIR: xcodeDeveloperDir(xcode) } : {}) };
    return makeTool(t, checked, [java, wrapper, wrapperJar, ...(cache ? [cache.distribution] : []),
      ...(sdk ? [join(sdk, "platforms", `android-${t.gradle?.android}`, "android.jar")] : []), ...(xcode ? [xcode] : [])], xcode || wrapper, runEnv,
      `${xcode ? "Xcode / " : ""}Gradle Wrapper · ${dirname(dirname(java))}`);
  });
}

export function toolchains(t: ProjectTarget, env: NodeJS.ProcessEnv, checked: Checks, root: string): Tool[] {
  if (t.gradle || t.xcode) return nativeTools(t, env, checked, root);
  if (t.cmake) {
    const ninja = installedExecutables("ninja", env)[0];
    const cxx = executables("clang++", env)[0] ?? executables("g++", env)[0];
    const cc = executables("clang", env)[0] ?? executables("gcc", env)[0];
    if (!ninja || !cxx || !cc) return [];
    return installedExecutables("cmake", env).filter((p) => ![p, ninja, cc, cxx].some(autoInstallRisk)).map((cmake) =>
      makeTool(t, checked, [cmake, ninja, cc, cxx], cmake, env, `CMake · ${dirname(cmake)}`));
  }
  if (t.adapter === "cargo") {
    const explicit = env.PROTOC;
    const protoc = t.requirements.protoc ? (explicit && isAbsolute(explicit) && executables(explicit, { PATH: dirname(explicit) })[0] || installedExecutables("protoc", env)[0]) : undefined;
    if (t.requirements.protoc && (!protoc || autoInstallRisk(protoc))) return [];
    return rustPairs(t, env).map(({ cargo, rustc, bin }) => makeTool(t, checked, [cargo, rustc, ...(protoc ? [protoc] : [])], cargo,
      { ...env, ...(protoc ? { PROTOC: protoc } : {}), RUSTC: rustc, RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "", PATH: [bin, env.PATH ?? ""].join(delimiter) }, `Cargo · ${bin}`));
  }
  if (t.adapter !== "npm" && t.adapter !== "pnpm" && !t.tauri) return [];
  const managerName = t.tauri ? "pnpm" : t.adapter;
  const rust = t.tauri && rustPairs(t, env)[0];
  const xcrun = t.tauri && executables("xcrun", { PATH: "/usr/bin" })[0];
  if (t.tauri && (t.blocked || !rust || !xcrun)) return [];
  return installedExecutables("node", env, t.requirements.miseNode).flatMap((node) => installedExecutables(managerName, env, t.requirements.manager).flatMap((manager) => {
    if (t.tauri && executables(managerName, { PATH: [dirname(node), dirname(manager)].join(delimiter) })[0] !== manager) return [];
    const runEnv = { ...env, PATH: [dirname(node), dirname(manager), rust ? rust.bin : "", env.PATH ?? ""].filter(Boolean).join(delimiter), COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0", ...(managerName === "pnpm" ? { npm_config_manage_package_manager_versions: "false", npm_config_package_manager_strict_version: "true" } : {}) };
    if (t.tauri && rust && xcrun) {
      const cli = resolveWithin(root, t.tauri.cli);
      const target = resolveWithin(root, t.tauri.targetDir);
      const tauriEnv = { ...runEnv, CARGO_TARGET_DIR: target, RUSTC: rust.rustc, RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "" };
      if (executables("cargo", tauriEnv)[0] !== rust.cargo) return [];
      return [makeTool(t, checked, [node, manager, rust.cargo, rust.rustc, xcrun, cli], cli, tauriEnv, `Tauri · ${dirname(manager)} · ${rust.bin}`)];
    }
    return [makeTool(t, checked, [node, manager], manager, runEnv, `${t.adapter} · ${dirname(node)} → ${dirname(manager)}`)];
  })).slice(0, 32);
}

function parseVersion(s: string) {
  return /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(s)?.slice(1).map((n) => Number(n ?? 0));
}

// Support the sample ranges and common comparator sets. Unknown syntax fails closed.
export function matchesVersion(found: string, range: string | undefined): boolean {
  const actual = parseVersion(found);
  if (!actual) return false;
  if (!range || range === "*") return true;
  return range.split("||").some((branch) => branch.trim().split(/\s+/u).every((term) => {
    const [, op = "", v = ""] = /^(>=|<=|>|<|=|\^|~)?(v?\d+(?:\.\d+){0,2})$/u.exec(term) ?? [];
    const required = parseVersion(v);
    if (!required) return false;
    const diff = actual.map((n, i) => n - required[i]!).find((n) => n !== 0) ?? 0;
    if (op === ">=") return diff >= 0;
    if (op === "<=") return diff <= 0;
    if (op === ">") return diff > 0;
    if (op === "<") return diff < 0;
    if (op === "~" || op === "^") {
      const first = required.findIndex((n) => n !== 0);
      const same = op === "~" ? Math.min(2, v.split(".").length) : first === -1 ? Math.min(3, v.split(".").length) : first + 1;
      return diff >= 0 && actual.slice(0, same).every((n, i) => n === required[i]);
    }
    return actual.slice(0, v.split(".").length).every((n, i) => n === required[i]);
  }));
}

export function buildArguments(root: string, t: ProjectTarget, opts: Configuration["options"], tool: Tool) {
  if (t.gradle || t.xcode) {
    if (opts.length) throw new Error("Gradle/Xcode 使用已声明的任务或固定 Debug 模拟器配置，不接受额外参数");
    const common = ["-disableAutomaticPackageResolution", "-skipPackageUpdates"];
    if (t.xcode) {
      const ws = ["-workspace", resolveWithin(root, t.xcode.workspace)];
      if (t.operation === "probe") return { args: ["-list", "-json", ...ws, ...common], outputs: [] };
      return { args: [...ws, "-scheme", t.name, "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", resolveWithin(root, t.xcode.derived), ...common,
        "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "COMPILER_INDEX_STORE_ENABLE=NO", "build"], outputs: t.outputs };
    }
    return { args: [...gradleFlags(tool), ...(t.operation ? ["tasks", "--all"] : [t.name])], outputs: t.outputs };
  }
  if (t.cmake) {
    if (opts.length) throw new Error("CMake 使用固定 Debug 配置，不接受额外参数");
    const dir = resolveWithin(root, t.cmake.dir);
    const [, ninja, cc, cxx] = tool.candidate.paths;
    if (t.operation === "probe") return { args: ["-S", resolveWithin(root, t.cwd), "-B", dir, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", `-DCMAKE_MAKE_PROGRAM=${ninja}`, `-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`], outputs: [] };
    if (t.cmake.tool !== tool.signature) throw new Error("构建目录使用了另一套工具或工具已变化，请用当前组合重新配置");
    return { args: ["--build", dir, "--config", "Debug", "--target", t.name], outputs: t.outputs };
  }
  if (t.tauri) {
    if (opts.length && (opts.length !== 1 || opts[0] !== "--no-bundle")) throw new Error("Tauri 使用 Debug --no-bundle，不接受签名或发布选项");
    return { args: ["build", "--debug", "--no-bundle", "--", "--locked"], outputs: t.outputs };
  }
  if (t.cargo) {
    const release = opts.length === 1 && opts[0] === "--release";
    if (opts.length && !release) throw new Error("Cargo 支持默认 debug 或 --release");
    const output = resolveWithin(root, t.cargo.targetDir);
    return { args: ["build", "--locked", "--target-dir", output, ...(t.cargo.name ? ["--package", t.cargo.name] : ["--workspace"]), ...(release ? ["--release"] : [])],
      outputs: t.outputs.map((p) => release ? p.replace(/\/debug(?=\/|$)/u, "/release") : p) };
  }
  return { args: npmArguments(t, opts), outputs: t.outputs };
}

function npmArguments(t: ProjectTarget, opts: Configuration["options"]) {
  for (let i = 0; i < opts.length; i += 2) {
    if (opts[i] !== "--mode" || !/^[a-zA-Z0-9][\w.-]{0,63}$/u.test(opts[i + 1] ?? "") || opts.length !== 2) {
      throw new Error("npm/pnpm 脚本仅支持 --mode <名称>；不接受包管理器或 shell 参数");
    }
  }
  return ["run", t.name, ...(opts.length ? [...(t.adapter === "npm" ? ["--"] : []), ...opts] : [])];
}

export async function checkedCommand(invocation: Invocation, owned: Set<OwnedProcess>, accept: () => void) {
  accept();
  let stdout = "";
  const proc = launch(invocation, (stream, text) => { if (stream === "stdout" && stdout.length < 64 * 1024) stdout += text.slice(0, 64 * 1024 - stdout.length); });
  owned.add(proc);
  const timer = setTimeout(() => proc.stop(), 8000);
  try {
    const exit = await proc.done;
    accept();
    if (exit.code !== 0 || exit.stopped || exit.error) throw new Error(`检查命令未完成：${invocation.executable} (${exit.error ?? exit.signal ?? exit.code})`);
    return stdout.trim();
  } finally { clearTimeout(timer); owned.delete(proc); }
}

function autoInstallRisk(path: string) {
  const real = realpathSync(path);
  return /(?:^|\/)(?:shims|corepack)(?:\/|$)/u.test(path) || /(?:^|\/)(?:corepack)(?:\/|$)/u.test(real);
}

export async function verifyTool(root: string, t: ProjectTarget, tool: Tool, owned: Set<OwnedProcess>, accept: () => void) {
  if (t.xcode) {
    const common = { cwd: tmpdir(), env: tool.env, executable: tool.executable };
    const version = await checkedCommand({ ...common, args: ["-version"] }, owned, accept);
    const sdk = await checkedCommand({ ...common, args: ["-version", "-sdk", "iphonesimulator", "SDKVersion"] }, owned, accept);
    if (!/^Xcode \d/u.test(version) || !matchesVersion(sdk, undefined)) throw new Error("未确认完整 Xcode 与 iPhone Simulator SDK");
    const gradle = t.gradle && !t.operation ? await verifyGradle(root, t, tool, owned, accept) : undefined;
    return [version.split("\n")[0], "iPhone Simulator SDK " + sdk, gradle].filter(Boolean).join(" · ");
  }
  if (t.gradle) return verifyGradle(root, t, tool, owned, accept);
  if (t.cmake) {
    const [cmake, ninja, cc, cxx] = tool.candidate.paths as [string, string, string, string];
    const check = (executable: string) => checkedCommand({ cwd: tmpdir(), env: tool.env, executable, args: ["--version"] }, owned, accept);
    const cv = (await check(cmake)).split("\n")[0] ?? "";
    const nv = (await check(ninja)).split("\n")[0] ?? "";
    const ccVersion = (await check(cc)).split("\n")[0] ?? "";
    const cxVersion = (await check(cxx)).split("\n")[0] ?? "";
    const found = /^cmake version (\d+\.\d+\.\d+)/u.exec(cv)?.[1];
    if (!found || !matchesVersion(found, ">=3.14")) throw new Error("未找到支持 File API 的 CMake");
    return [cv, "Ninja " + nv, ccVersion, cxVersion].map((v) => v.slice(0, 100)).join(" · ");
  }
  if (t.adapter === "cargo" || t.tauri) {
    const [cargo, rustc, protoc] = t.tauri ? tool.candidate.paths.slice(2, 4) : tool.candidate.paths;
    if (!cargo || !rustc) throw new Error("缺少 Cargo 或 rustc");
    const common = { cwd: tmpdir(), env: tool.env, args: ["--version"] };
    const cv = await checkedCommand({ ...common, executable: cargo }, owned, accept);
    const rv = await checkedCommand({ ...common, executable: rustc }, owned, accept);
    const found = /^rustc (\d+\.\d+\.\d+)/u.exec(rv)?.[1];
    if (!found || !matchesVersion(found, t.requirements.rust && `>=${t.requirements.rust}`)) throw new Error(`Rust 版本不符合要求：${rv.slice(0, 80)}`);
    const rust = `${cv.split(" ").slice(0, 2).join(" ")} · ${rv.split(" ").slice(0, 2).join(" ")}`;
    if (!t.tauri) return protoc ? `${rust} · ${(await checkedCommand({ ...common, executable: protoc }, owned, accept)).slice(0, 80)}` : rust;
    const [, , , , xcrun, cli] = tool.candidate.paths;
    if (!xcrun || !cli) throw new Error("缺少 macOS SDK 或项目内 Tauri CLI");
    const js = await verifyJs(t, tool, owned, accept, "pnpm");
    const sdk = await checkedCommand({ ...common, executable: xcrun, args: ["--sdk", "macosx", "--show-sdk-path"] }, owned, accept);
    if (!isAbsolute(sdk) || !statSync(sdk).isDirectory()) throw new Error("未确认 macOS SDK");
    const cliVersion = await checkedCommand({ ...common, executable: cli }, owned, accept);
    if (!/^tauri-cli 2\./u.test(cliVersion)) throw new Error("需要项目内 Tauri CLI 2.x");
    return `${js} · ${rust} · ${cliVersion.slice(0, 80)} · ${sdk.split("/").at(-1)}`;
  }
  if (t.adapter === "npm" || t.adapter === "pnpm") return verifyJs(t, tool, owned, accept, t.adapter);
  throw new Error("该目标没有可验证的工具链");
}

function gradleFlags(tool: Tool) {
  return ["--offline", "--no-daemon", "--console=plain", "-Dorg.gradle.native=false", `-Dorg.gradle.java.home=${tool.env.JAVA_HOME}`,
    "-Porg.gradle.java.installations.auto-download=false", "-Pandroid.builder.sdkDownload=false", "-Pkotlin.compiler.execution.strategy=in-process"];
}

async function verifyGradle(root: string, t: ProjectTarget, tool: Tool, owned: Set<OwnedProcess>, accept: () => void) {
  const [java, wrapper] = tool.candidate.paths;
  if (!java || !wrapper || !t.gradle) throw new Error("缺少 Gradle Wrapper 或 JDK");
  const common = { cwd: tmpdir(), env: tool.env };
  const jvm = await checkedCommand({ ...common, executable: java, args: ["--version"] }, owned, accept);
  if (!/^(?:openjdk|java) 17(?:[.\s]|$)/u.test(jvm)) throw new Error("需要 JDK 17");
  const cache = gradleCache(t.gradle, tool.env);
  if (!cache || !tool.candidate.paths.includes(cache.distribution)) throw new Error(`未验证：没有已解压的 Gradle ${t.gradle.version} Wrapper 缓存，不触发下载`);
  const cwd = resolveWithin(root, t.xcode ? "." : t.cwd);
  const output = await checkedCommand({ ...common, cwd, executable: wrapper, args: [...gradleFlags(tool), "--version"] }, owned, accept);
  const observed = /^Gradle (\S+)\s*$/mu.exec(output)?.[1];
  const launcher = /^Launcher JVM:\s*17(?:[.\s]|$)/mu.test(output);
  const daemon = /^Daemon JVM:\s*(.*)$/mu.exec(output)?.[1] ?? "";
  if (observed !== t.gradle.version || !launcher || !tool.env.JAVA_HOME || !daemon.startsWith(tool.env.JAVA_HOME + " ") && daemon !== tool.env.JAVA_HOME) {
    throw new Error("未确认 Gradle Launcher 和 daemon 均使用所选 JDK 17");
  }
  const { sdk, issue } = androidState(t, tool.env);
  if (issue) throw new Error(issue);
  return `Gradle ${observed} · Launcher/daemon JDK 17${sdk ? " · Android SDK " + t.gradle.android : ""}`;
}

async function verifyJs(t: ProjectTarget, tool: Tool, owned: Set<OwnedProcess>, accept: () => void, managerName: string) {
  const [node, manager] = tool.candidate.paths;
  if (!node || !manager || [node, manager].some(autoInstallRisk)) throw new Error("未验证：请选择已安装的真实 Node 和包管理器，避免 shim 自动安装工具");
  if ([node, manager].some((p) => !lstatSync(realpathSync(p)).isFile())) throw new Error("工具已失效，请刷新");
  const common = { cwd: tmpdir(), env: tool.env, args: ["--version"] };
  const nv = await checkedCommand({ ...common, executable: node }, owned, accept);
  let mv: string;
  if (managerName === "npm") {
    const reported = await checkedCommand({ ...common, executable: manager, args: ["--versions", "--json"] }, owned, accept);
    let versions: { node?: string; npm?: string } | null;
    try { versions = JSON.parse(reported) as typeof versions; }
    catch (error) { throw new Error("无法读取 npm 报告的运行时版本", { cause: error }); }
    if (!versions?.node || versions.node !== nv.replace(/^v/u, "") || typeof versions.npm !== "string") {
      throw new Error("npm 实际使用的 Node 与所选 Node 不一致");
    }
    mv = versions.npm;
  } else {
    mv = await checkedCommand({ ...common, executable: manager }, owned, accept);
  }
  if (!matchesVersion(nv, t.requirements.node) || !matchesVersion(nv, t.requirements.miseNode) || !matchesVersion(mv, t.requirements.manager) || !matchesVersion(mv, t.requirements.managerEngine)) {
    throw new Error(`版本不符合要求或声明无法验证：Node ${nv.slice(0, 60)} · ${managerName} ${mv.slice(0, 60)}；需要 ${requirement(t)}`);
  }
  return `Node ${nv} · ${managerName} ${mv}`;
}
