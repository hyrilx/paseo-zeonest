import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { satisfies, valid, validRange } from "semver";
import type { Candidate, Configuration } from "../shared/contracts";
import { digest, resolveWithin } from "./paths";
import { autoInstallRisk, directories, executable, executables, installedExecutables } from "./mise";
import { launch } from "./process";
import type { Invocation, OwnedProcess } from "./process";
import type { ProjectTarget } from "./projects";

export type Tool = { candidate: Candidate; signature: string; executable: string; env: NodeJS.ProcessEnv };
export type Checks = Map<string, string>;

export function identity(path: string) {
  const s = statSync(path, { bigint: true });
  return [path, realpathSync(path), s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}

export function requirement(t: ProjectTarget) {
  if (t.xcode) return "完整 Xcode · iPhone Simulator SDK";
  if (t.gradle) return `${t.gradle.wrapper ? "项目 Gradle Wrapper" : "Gradle"} · Java（兼容性由 Gradle 检查）`;
  if (t.cmake) return "CMake ≥ 3.14 · 生成器和编译器由配置检查";
  if (t.tauri) return [t.tauri.manager && jsRequirement(t, t.tauri.manager), "Cargo + rustc", t.tauri.cli ? "项目声明的 Tauri CLI" : "cargo-tauri", "平台构建依赖"].filter(Boolean).join(" · ");
  if (t.adapter === "cargo") return `Cargo + rustc${t.requirements.rustChannel ? " · " + t.requirements.rustChannel : ""}${t.requirements.rust ? " · Rust >=" + t.requirements.rust : ""}`;
  return jsRequirement(t, t.adapter);
}

function jsRequirement(t: ProjectTarget, manager: string) {
  return `Node ${[t.requirements.miseNode, t.requirements.node].filter(Boolean).join(" 且 ") || "（项目未指定版本）"} · ${manager} ${[t.requirements.manager, t.requirements.managerEngine].filter(Boolean).join(" 且 ") || "（项目未指定版本）"}`;
}

function makeTool(t: ProjectTarget, checked: Checks, paths: string[], executable: string, env: NodeJS.ProcessEnv, label: string): Tool {
  const id = digest(JSON.stringify(paths)).slice(0, 32);
  const signature = digest(JSON.stringify([t.requirements, t.gradle, t.xcode, env.JAVA_HOME, env.ANDROID_HOME, env.DEVELOPER_DIR, env.GRADLE_USER_HOME, ...paths.map(identity)]));
  return { candidate: { id, paths, label, requirement: requirement(t), version: checked.get(signature) }, executable, env, signature };
}

function rustPairs(t: ProjectTarget, env: NodeJS.ProcessEnv) {
  const rust = env.RUSTUP_HOME ?? join(env.HOME ?? homedir(), ".rustup");
  const dirs = [...directories(join(rust, "toolchains")).map((p) => join(p, "bin")), ...installedExecutables("cargo", env).map(dirname)];
  return executables("cargo", { PATH: dirs.join(delimiter) }).flatMap((cargo) => {
    const bin = dirname(cargo);
    const rustc = executables("rustc", { PATH: bin })[0];
    const channel = dirname(bin).split("/").at(-1) ?? "";
    if (!rustc || [cargo, rustc].some((p) => realpathSync(p).endsWith("/rustup") || autoInstallRisk(p))) return [];
    if (t.requirements.rustChannel && channel !== t.requirements.rustChannel && !channel.startsWith(t.requirements.rustChannel + "-")) return [];
    return [{ cargo, rustc, bin }];
  });
}

function xcodeExecutable(env: NodeJS.ProcessEnv) {
  if (process.platform !== "darwin") return undefined;
  const selected = env.DEVELOPER_DIR;
  if (selected) {
    const dir = selected.endsWith(".app") ? join(selected, "Contents/Developer") : selected;
    return executables("xcodebuild", { PATH: join(dir, "usr/bin") })[0];
  }
  const standard = "/Applications/Xcode.app/Contents/Developer";
  let active: string | undefined;
  try { active = realpathSync("/var/db/xcode_select_link"); }
  catch { /* Xcode may not have been selected. */ }
  const dirs = [active, standard, ...directories("/Applications").filter((dir) => /\/Xcode[^/]*\.app$/u.test(dir)).map((dir) => join(dir, "Contents/Developer"))];
  return executables("xcodebuild", { PATH: dirs.filter(Boolean).map((dir) => join(dir!, "usr/bin")).join(delimiter) })[0]
    ?? executables("xcodebuild", env).find((path) => /\.app\/Contents\/Developer\/usr\/bin\/xcodebuild$/u.test(path));
}

const xcodeDeveloperDir = (executable: string) => dirname(dirname(dirname(executable)));

export function toolIssues(t: ProjectTarget, env: NodeJS.ProcessEnv) {
  const issues: string[] = [];
  if (t.blocked) issues.push(t.blocked);
  if (t.xcode && !xcodeExecutable(env)) issues.push("没有找到完整 Xcode；仅安装 Command Line Tools 无法构建 iPhone Simulator 产物。");
  if (t.gradle && !t.gradle.wrapper && !installedExecutables("gradle", env).length) issues.push("未找到 Gradle Wrapper 或已安装的 Gradle。");
  return issues;
}

function nativeTools(t: ProjectTarget, env: NodeJS.ProcessEnv, checked: Checks, root: string): Tool[] {
  if (t.xcode) {
    const xcode = xcodeExecutable(env);
    return xcode ? [makeTool(t, checked, [xcode], xcode, { ...env, DEVELOPER_DIR: xcodeDeveloperDir(xcode) }, `Xcode · ${xcode}`)] : [];
  }
  if (!t.gradle) return [];
  const wrapper = t.gradle.wrapper ? resolveWithin(root, t.gradle.wrapper) : undefined;
  const jar = t.gradle.jar ? resolveWithin(root, t.gradle.jar) : undefined;
  const gradles = wrapper ? [wrapper] : installedExecutables("gradle", env);
  const preferred = env.JAVA_HOME && isAbsolute(env.JAVA_HOME) ? executables("java", { PATH: join(env.JAVA_HOME, "bin") }) : [];
  const systemJdks = process.platform === "darwin" ? directories("/Library/Java/JavaVirtualMachines").map((dir) => join(dir, "Contents/Home/bin/java")) : [];
  const javaExecutables = [...new Set([...preferred, ...installedExecutables("java", env, t.requirements.miseJava), ...systemJdks])]
    .filter((path) => executable(path) && (process.platform !== "darwin" || realpathSync(path) !== "/usr/bin/java") && !autoInstallRisk(path));
  return javaExecutables.flatMap((java) => gradles.map((gradle) => {
    const javaHome = dirname(dirname(realpathSync(java)));
    // Gradle's native daemon can detach; keep launcher and forked JVM integration disabled.
    const runEnv = { ...env, JAVA_HOME: javaHome, PATH: [join(javaHome, "bin"), env.PATH ?? ""].join(delimiter),
      JAVA_TOOL_OPTIONS: [env.JAVA_TOOL_OPTIONS, "-Dorg.gradle.native=false"].filter(Boolean).join(" ") };
    return makeTool(t, checked, [java, gradle, ...(jar ? [jar] : [])], gradle, runEnv,
      `${wrapper ? "Gradle Wrapper" : gradle} · ${javaHome}`);
  })).slice(0, 32);
}

export function toolchains(t: ProjectTarget, env: NodeJS.ProcessEnv, checked: Checks, root: string): Tool[] {
  if (t.gradle || t.xcode) return nativeTools(t, env, checked, root);
  if (t.cmake) {
    const ninja = installedExecutables("ninja", env)[0];
    const runEnv = { ...env, PATH: [ninja && dirname(ninja), env.PATH].filter(Boolean).join(delimiter) };
    return installedExecutables("cmake", env, t.requirements.miseCmake).map((cmake) =>
      makeTool(t, checked, [cmake, ...(ninja ? [ninja] : [])], cmake, runEnv, `CMake · ${dirname(cmake)}`));
  }
  if (t.adapter === "cargo") {
    const protoc = env.PROTOC && isAbsolute(env.PROTOC) && executable(env.PROTOC) ? env.PROTOC : installedExecutables("protoc", env)[0];
    return rustPairs(t, env).map(({ cargo, rustc, bin }) => makeTool(t, checked, [cargo, rustc, ...(protoc ? [protoc] : [])], cargo,
      { ...env, ...(protoc ? { PATH: [bin, dirname(protoc), env.PATH ?? ""].join(delimiter) } : { PATH: [bin, env.PATH ?? ""].join(delimiter) }), RUSTC: rustc }, `Cargo · ${bin}`));
  }
  if (t.tauri) {
    const tauri = t.tauri;
    const rust = rustPairs(t, env)[0];
    const xcrun = process.platform === "darwin" ? executables("xcrun", { PATH: "/usr/bin" })[0] : undefined;
    const rustCli = !tauri.cli && (executables("cargo-tauri", { PATH: join(env.CARGO_HOME ?? join(env.HOME ?? homedir(), ".cargo"), "bin") })[0] ?? installedExecutables("cargo-tauri", env)[0]);
    if (!rust || (tauri.cli ? !tauri.manager : !rustCli)) return [];
    const protoc = installedExecutables("protoc", env)[0];
    const rustEnv = { ...env, RUSTC: rust.rustc, PATH: [rust.bin, rustCli && dirname(rustCli), protoc && dirname(protoc), env.PATH].filter(Boolean).join(delimiter) };
    const paths = [rust.cargo, rust.rustc, ...(xcrun ? [xcrun] : []), ...(rustCli ? [rustCli] : [])];
    if (tauri.manager) return jsTools(t, env, tauri.manager).map(({ node, manager, env: runtime }) => {
      const runEnv = { ...rustEnv, ...runtime, RUSTC: rust.rustc, PATH: [dirname(manager), dirname(node), rustEnv.PATH].join(delimiter) };
      return makeTool(t, checked, [node, manager, ...paths], manager, runEnv, `Tauri · ${tauri.manager} · ${rust.bin}`);
    });
    return [makeTool(t, checked, paths, rust.cargo, rustEnv, `Tauri · ${rust.bin}`)];
  }
  if (t.adapter !== "npm" && t.adapter !== "pnpm") return [];
  return jsTools(t, env, t.adapter).map(({ node, manager, env: runEnv }) => makeTool(t, checked,
    [node, manager], manager, runEnv, `${t.adapter} · ${dirname(node)} → ${dirname(manager)}`));
}

function jsTools(t: ProjectTarget, env: NodeJS.ProcessEnv, name: "npm" | "pnpm") {
  return installedExecutables("node", env, t.requirements.miseNode).flatMap((node) =>
    installedExecutables(name, env, t.requirements.manager).flatMap((manager) => {
      // Child scripts and hooks invoking the manager by name must see the same installation.
      const path = [dirname(manager), dirname(node), env.PATH ?? ""].join(delimiter);
      if (realpathSync(executables("node", { PATH: path })[0] ?? node) !== realpathSync(node)) return [];
      return [{ node, manager, env: { ...env, PATH: path,
        ...(name === "pnpm" ? { npm_config_manage_package_manager_versions: "false", npm_config_package_manager_strict_version: "true" } : {}) } }];
    })).slice(0, 32);
}

export function matchesVersion(found: string, range: string | undefined): boolean {
  const value = valid(found) ?? (/^\d+\.\d+$/u.test(found) ? valid(found + ".0") : null);
  return !!value && (!range || satisfies(value, range, { includePrerelease: true }));
}

function matchesMiseVersion(found: string, range: string | undefined) {
  // Labels such as lts or latest are manager selection hints, not semver expressions.
  return !range || validRange(range) === null || matchesVersion(found, range);
}

export function buildArguments(root: string, t: ProjectTarget, opts: Configuration["options"], tool: Tool) {
  if (t.gradle || t.xcode) {
    if (opts.length) throw new Error("Gradle/Xcode 使用已声明的任务或固定 Debug 模拟器配置，不接受额外参数");
    if (t.xcode) {
      const container = [`-${t.xcode.kind}`, resolveWithin(root, t.project)];
      if (t.operation === "probe") return { args: ["-list", "-json", ...container], outputs: [] };
      return { args: [...container, "-scheme", t.name, "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", resolveWithin(root, t.xcode.derived),
        "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "build"], outputs: t.outputs };
    }
    return { args: ["--no-daemon", "--console=plain", "-Pkotlin.compiler.execution.strategy=in-process", ...(t.operation ? ["tasks", "--all"] : [t.name])], outputs: t.outputs };
  }
  if (t.cmake) {
    if (opts.length) throw new Error("CMake 使用已选配置，不接受额外参数");
    const dir = resolveWithin(root, t.cmake.dir);
    const [, ninja] = tool.candidate.paths;
    if (t.operation === "probe") {
      const generator = ninja && !tool.env.CMAKE_GENERATOR ? ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`] : [];
      const config = t.cmake.preset ? ["--preset", t.cmake.preset] : [...generator, "-DCMAKE_BUILD_TYPE=Debug"];
      return { args: [...config, "-S", resolveWithin(root, t.cwd), "-B", dir], outputs: [] };
    }
    if (t.cmake.tool !== tool.signature || !t.cmake.target) throw new Error("构建目录使用了另一套工具或工具已变化，请用当前组合重新配置");
    const config = t.cmake.configuration ? ["--config", t.cmake.configuration] : [];
    return { args: ["--build", dir, ...config, "--target", t.cmake.target], outputs: t.outputs };
  }
  if (t.tauri) {
    if (opts.length && (opts.length !== 1 || opts[0] !== "--no-bundle")) throw new Error("Tauri 使用 Debug --no-bundle，不接受签名或发布选项");
    const invoke = t.tauri.manager === "npm" ? ["exec", "--no", "--", "tauri"] : t.tauri.manager === "pnpm" ? ["exec", "tauri"] : ["tauri"];
    return { args: [...invoke, "build", "--debug", "--no-bundle"], outputs: t.outputs };
  }
  if (t.cargo) {
    const release = opts.length === 1 && opts[0] === "--release";
    if (opts.length && !release) throw new Error("Cargo 支持默认 debug 或 --release");
    return { args: ["build", ...(t.cargo.name ? ["--package", t.cargo.name] : ["--workspace"]), ...(release ? ["--release"] : [])],
      outputs: t.outputs.map((p) => release ? p.replace(/\/debug(?=\/|$)/u, "/release") : p) };
  }
  return { args: npmArguments(t, opts), outputs: t.outputs };
}

export function preparation(root: string, t: ProjectTarget, tool: Tool): { cwd: string; invocation: Invocation }[] {
  const manager = t.tauri?.manager ?? t.adapter;
  const install = t.install;
  if (!install || (manager !== "npm" && manager !== "pnpm") || !install.required.length) return [];
  const cwd = resolveWithin(root, install.cwd);
  const paths = [...new Set([resolveWithin(root, t.cwd), cwd])];
  const installed = (dep: string) => paths.some((dir) => {
    try { return statSync(join(dir, "node_modules", dep, "package.json")).isFile(); }
    catch { return false; }
  });
  if (install.required.every(installed)) return [];
  const args = manager === "npm"
    ? [install.lock ? "ci" : "install", "--include=dev"]
    : ["install", "--prod=false", ...(install.lock ? ["--frozen-lockfile"] : [])];
  return [{ cwd: install.cwd, invocation: { executable: tool.executable, args, cwd, env: tool.env } }];
}

function npmArguments(t: ProjectTarget, opts: Configuration["options"]) {
  for (let i = 0; i < opts.length; i += 2) {
    if (opts[i] !== "--mode" || !/^[a-zA-Z0-9][\w.-]{0,63}$/u.test(opts[i + 1] ?? "") || opts.length !== 2) {
      throw new Error("npm/pnpm 脚本仅支持 --mode <名称>；不接受包管理器或 shell 参数");
    }
  }
  return ["run", t.name, ...(opts.length ? [...(t.adapter === "npm" ? ["--"] : []), ...opts] : [])];
}

export async function checkedCommand(invocation: Invocation, owned: Set<OwnedProcess>, accept: () => void, stderr = false) {
  accept();
  let stdout = "";
  const proc = launch(invocation, (stream, text) => { if ((stream === "stdout" || stderr) && stdout.length < 64 * 1024) stdout += text.slice(0, 64 * 1024 - stdout.length); });
  owned.add(proc);
  const timer = setTimeout(() => proc.stop(), 8000);
  try {
    const exit = await proc.done;
    accept();
    if (exit.code !== 0 || exit.stopped || exit.error) throw new Error(`检查命令未完成：${invocation.executable} (${exit.error ?? exit.signal ?? exit.code})`);
    return stdout.trim();
  } finally { clearTimeout(timer); owned.delete(proc); }
}

export async function verifyTool(t: ProjectTarget, tool: Tool, owned: Set<OwnedProcess>, accept: () => void) {
  if (t.xcode) {
    const common = { cwd: tmpdir(), env: tool.env, executable: tool.executable };
    const version = await checkedCommand({ ...common, args: ["-version"] }, owned, accept);
    const sdk = await checkedCommand({ ...common, args: ["-version", "-sdk", "iphonesimulator", "SDKVersion"] }, owned, accept);
    if (!/^Xcode \d/u.test(version) || !matchesVersion(sdk, undefined)) throw new Error("未确认完整 Xcode 与 iPhone Simulator SDK");
    return [version.split("\n")[0], "iPhone Simulator SDK " + sdk].join(" · ");
  }
  if (t.gradle) {
    const java = tool.candidate.paths[0];
    if (!java) throw new Error("缺少 Java");
    const output = await checkedCommand({ cwd: tmpdir(), env: { ...tool.env, JAVA_TOOL_OPTIONS: undefined }, executable: java, args: ["-version"] }, owned, accept, true);
    return `启动 Java：${output.split("\n")[0]}（Gradle/JVM 由项目确定）`;
  }
  if (t.cmake) {
    const cmake = tool.executable;
    const [, ninja] = tool.candidate.paths;
    const check = (executable: string) => checkedCommand({ cwd: tmpdir(), env: tool.env, executable, args: ["--version"] }, owned, accept);
    const cv = (await check(cmake)).split("\n")[0] ?? "";
    const nv = ninja && (await check(ninja)).split("\n")[0];
    const found = /^cmake version (\d+\.\d+\.\d+)/u.exec(cv)?.[1];
    if (!found || !matchesVersion(found, t.cmake.preset ? ">=3.19" : ">=3.14") || !matchesMiseVersion(found, t.requirements.miseCmake)) {
      throw new Error("CMake 版本不支持所选配置，或与 mise 声明不符");
    }
    return [cv, nv && "Ninja " + nv].filter(Boolean).join(" · ");
  }
  if (t.adapter === "cargo" || t.tauri) {
    const offset = t.tauri?.manager ? 2 : 0;
    const [cargo, rustc, extra, next] = tool.candidate.paths.slice(offset);
    if (!cargo || !rustc) throw new Error("缺少 Cargo 或 rustc");
    const common = { cwd: tmpdir(), env: tool.env, args: ["--version"] };
    const cv = await checkedCommand({ ...common, executable: cargo }, owned, accept);
    const rv = await checkedCommand({ ...common, executable: rustc }, owned, accept);
    const found = /^rustc (\d+\.\d+\.\d+)/u.exec(rv)?.[1];
    if (!found || !matchesVersion(found, t.requirements.rust && `>=${t.requirements.rust}`)) throw new Error(`Rust 版本不符合要求：${rv.slice(0, 80)}`);
    const rust = `${cv.split(" ").slice(0, 2).join(" ")} · ${rv.split(" ").slice(0, 2).join(" ")}`;
    if (!t.tauri) return extra ? `${rust} · ${(await checkedCommand({ ...common, executable: extra }, owned, accept)).slice(0, 80)}` : rust;
    const js = t.tauri.manager && await verifyJs(t, tool, owned, accept, t.tauri.manager);
    const xcrun = process.platform === "darwin" ? extra : undefined;
    let sdk: string | undefined;
    if (xcrun) {
      sdk = await checkedCommand({ ...common, executable: xcrun, args: ["--sdk", "macosx", "--show-sdk-path"] }, owned, accept);
      if (!isAbsolute(sdk) || !statSync(sdk).isDirectory()) throw new Error("未确认 macOS SDK");
    }
    const cli = !t.tauri.cli && (xcrun ? next : extra);
    const cliVersion = cli && await checkedCommand({ ...common, executable: cargo, args: ["tauri", "--version"] }, owned, accept);
    return [js, rust, sdk?.split("/").at(-1), cliVersion || "Tauri CLI 由项目依赖提供"].filter(Boolean).join(" · ");
  }
  if (t.adapter === "npm" || t.adapter === "pnpm") return verifyJs(t, tool, owned, accept, t.adapter);
  throw new Error("该目标没有可验证的工具链");
}

async function verifyJs(t: ProjectTarget, tool: Tool, owned: Set<OwnedProcess>, accept: () => void, managerName: string) {
  const [node, manager] = tool.candidate.paths;
  if (!node || !manager || [node, manager].some(autoInstallRisk)) throw new Error("请选择已安装的 Node 和包管理器。");
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
  if (!matchesVersion(nv, t.requirements.node) || !matchesMiseVersion(nv, t.requirements.miseNode) || !matchesVersion(mv, t.requirements.manager) || !matchesVersion(mv, t.requirements.managerEngine)) {
    throw new Error(`版本不符合要求或声明无法验证：Node ${nv.slice(0, 60)} · ${managerName} ${mv.slice(0, 60)}；需要 ${requirement(t)}`);
  }
  return `Node ${nv} · ${managerName} ${mv}`;
}
