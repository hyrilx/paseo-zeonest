import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { satisfies, valid, validRange } from "semver";
import type { Candidate, Configuration } from "../shared/contracts";
import { at, digest, inside, readBounded, resolveWithin } from "./paths";
import { ancestors, autoInstallRisk, directories, executable, executables, installedExecutables } from "./mise";
import { cargoOptions, cmakeOptions, gradleOptions, tauriOptions, xcodeOptions } from "./options";
import { launch } from "./process";
import type { Invocation, OwnedProcess } from "./process";
import type { ProjectTarget } from "./projects";

export type Tool = { candidate: Candidate; signature: string; executable: string; env: NodeJS.ProcessEnv; tauriSdkCheck?: string; tauriCargoCli?: string };
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
  const cmakeSelection = t.cmake && [env.CMAKE_GENERATOR, env.CMAKE_GENERATOR_PLATFORM, env.CMAKE_GENERATOR_TOOLSET, env.CMAKE_GENERATOR_INSTANCE, env.CMAKE_TOOLCHAIN_FILE, env.CC, env.CXX];
  const signature = digest(JSON.stringify([t.requirements, t.gradle, t.xcode, cmakeSelection, env.PATH, env.JAVA_HOME, env.ANDROID_HOME, env.DEVELOPER_DIR, env.GRADLE_USER_HOME, env.PROTOC, ...paths.map(identity)]));
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

function xcodeExecutables(env: NodeJS.ProcessEnv) {
  if (process.platform !== "darwin") return [];
  const selected = env.DEVELOPER_DIR?.replace(/\/+$/u, "");
  let active: string | undefined;
  try { active = realpathSync("/var/db/xcode_select_link"); }
  catch { /* Xcode may not have been selected. */ }
  const apps = ["/Applications", join(env.HOME ?? homedir(), "Applications")].flatMap((root) => directories(root));
  const dirs = [selected?.endsWith(".app") ? join(selected, "Contents/Developer") : selected, active, "/Applications/Xcode.app/Contents/Developer",
    ...apps.filter((dir) => dir.endsWith(".app")).map((dir) => join(dir, "Contents/Developer"))];
  const found = [...dirs.flatMap((dir) => dir && isAbsolute(dir) && dir !== "/Library/Developer/CommandLineTools" ? [join(dir, "usr/bin/xcodebuild")] : []),
    ...executables("xcodebuild", env).filter((path) => /\.app\/Contents\/Developer\/usr\/bin\/xcodebuild$/u.test(path))];
  const byPath = new Map<string, string>();
  for (const path of found) {
    if (!executable(path)) continue;
    const real = realpathSync(path);
    if (!byPath.has(real)) byPath.set(real, path);
  }
  return [...byPath.values()].slice(0, 16);
}

const xcodeDeveloperDir = (executable: string) => dirname(dirname(dirname(executable)));

export function toolIssues(t: ProjectTarget, env: NodeJS.ProcessEnv) {
  const issues: string[] = [];
  if (t.blocked) issues.push(t.blocked);
  if (t.xcode && !xcodeExecutables(env).length) issues.push("没有找到完整 Xcode；仅安装 Command Line Tools 无法构建 iPhone Simulator 产物。");
  if (t.gradle && !t.gradle.wrapper && !installedExecutables("gradle", env).length) issues.push("未找到 Gradle Wrapper 或已安装的 Gradle。");
  return issues;
}

function nativeTools(t: ProjectTarget, env: NodeJS.ProcessEnv, checked: Checks, root: string): Tool[] {
  if (t.xcode) {
    return xcodeExecutables(env).map((xcode) => makeTool(t, checked, [xcode], xcode, { ...env, DEVELOPER_DIR: xcodeDeveloperDir(xcode) }, `Xcode · ${xcode}`));
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
    const runEnv = { ...env, PATH: supplementalPath("ninja", env) };
    return installedExecutables("cmake", env, t.requirements.miseCmake).map((cmake) =>
      makeTool(t, checked, [cmake], cmake, runEnv, `CMake · ${dirname(cmake)}`));
  }
  if (t.adapter === "cargo" || t.tauri) {
    const tauri = t.tauri;
    const xcrun = tauri && process.platform === "darwin" ? executables("xcrun", { PATH: "/usr/bin" })[0] : undefined;
    const rustCli = tauri && !tauri.manager ? executables("cargo-tauri", { PATH: join(env.CARGO_HOME ?? join(env.HOME ?? homedir(), ".cargo"), "bin") })[0] ?? installedExecutables("cargo-tauri", env)[0] : undefined;
    if (tauri && !tauri.manager && !rustCli) return [];
    const inherited = supplementalPath("protoc", env);
    const js = tauri?.manager ? jsTools(t, env, tauri.manager) : [];
    return rustPairs(t, env).flatMap(({ cargo, rustc, bin }) => {
      const rustEnv = { ...env, RUSTC: rustc, PATH: [bin, rustCli && dirname(rustCli), inherited].filter(Boolean).join(delimiter) };
      const paths = [cargo, rustc, ...(xcrun ? [xcrun] : []), ...(rustCli ? [rustCli] : [])];
      if (!tauri) return [makeTool(t, checked, paths, cargo, rustEnv, `Cargo · ${bin}`)];
      if (!tauri.manager) return [{ ...makeTool(t, checked, paths, cargo, rustEnv, `Tauri · ${bin}`), tauriSdkCheck: xcrun, tauriCargoCli: rustCli }];
      return js.map(({ node, manager, env: runtime }) => {
        const runEnv = { ...runtime, RUSTC: rustc, PATH: [dirname(manager), dirname(node), rustEnv.PATH].join(delimiter) };
        return { ...makeTool(t, checked, [node, manager, ...paths], manager, runEnv, `Tauri · ${tauri.manager} · ${bin} · ${dirname(node)} → ${dirname(manager)}`), tauriSdkCheck: xcrun };
      });
    });
  }
  if (t.adapter !== "npm" && t.adapter !== "pnpm") return [];
  return jsTools(t, env, t.adapter).map(({ node, manager, env: runEnv }) => makeTool(t, checked,
    [node, manager], manager, runEnv, `${t.adapter} · ${dirname(node)} → ${dirname(manager)}`));
}

function supplementalPath(name: string, env: NodeJS.ProcessEnv) {
  // Make a discovered helper available without selecting it or checking it for projects that don't use it.
  if (executables(name, env).some((path) => !autoInstallRisk(path))) return env.PATH;
  const helper = installedExecutables(name, env)[0];
  return [helper && dirname(helper), env.PATH].filter(Boolean).join(delimiter);
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
  if (t.xcode) {
    const chosen = xcodeOptions(opts, !!t.operation).get("-configuration");
    const container = [`-${t.xcode.kind}`, resolveWithin(root, t.project)];
    if (t.operation === "probe") return { args: ["-list", "-json", ...container, ...opts], outputs: [] };
    return { args: [...container, "-scheme", t.name, ...(chosen ? [] : ["-configuration", "Debug"]), "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
      "-derivedDataPath", resolveWithin(root, t.xcode.derived), ...opts, "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "build"],
    outputs: [`${t.xcode.derived}/Build/Products/${chosen ?? "Debug"}-iphonesimulator`] };
  }
  if (t.gradle) {
    gradleOptions(opts, !!t.operation);
    return { args: ["--no-daemon", "--console=plain", ...(t.operation ? ["tasks", "--all"] : [t.name]), ...opts], outputs: t.outputs };
  }
  if (t.cmake) {
    const chosen = cmakeOptions(opts, !!t.operation);
    const dir = resolveWithin(root, t.cmake.dir);
    if (t.operation === "probe") {
      const config = t.cmake.preset ? ["--preset", t.cmake.preset] : [];
      return { args: [...config, ...opts, "-S", resolveWithin(root, t.cwd), "-B", dir], outputs: [] };
    }
    if (t.cmake.tool !== tool.signature || !t.cmake.target) throw new Error("构建目录使用了另一套工具或工具已变化，请用当前组合重新配置");
    const config = !chosen && t.cmake.configuration ? ["--config", t.cmake.configuration] : [];
    return { args: ["--build", dir, ...config, "--target", t.cmake.target, ...opts], outputs: chosen && chosen !== t.cmake.configuration ? [t.cmake.dir] : t.outputs };
  }
  if (t.tauri) {
    const selected = tauriOptions(root, t.cwd, opts);
    const invoke = t.tauri.manager === "npm" ? ["exec", "--no", "--", "tauri"] : t.tauri.manager === "pnpm" ? ["exec", "tauri"] : ["tauri"];
    return { args: [...invoke, "build", ...(selected.debug ? ["--debug"] : []), "--no-bundle", ...selected.args],
      outputs: rustOutputs(t.outputs, t.tauri.targetDir, selected.debug ? "debug" : "release", selected.target ? [selected.target] : []) };
  }
  if (t.cargo) {
    const { profile, targets } = cargoOptions(root, t.cwd, opts);
    return { args: ["build", ...(t.cargo.name ? ["--package", t.cargo.name] : ["--workspace"]), ...opts],
      outputs: rustOutputs(t.outputs, t.cargo.targetDir, profile, targets) };
  }
  // The package script owns its arguments. npm needs a separator; pnpm forwards everything after the script name.
  return { args: ["run", t.name, ...(opts.length && t.adapter === "npm" ? ["--"] : []), ...opts], outputs: t.outputs };
}

function rustOutputs(outputs: string[], dir: string, profile: string, targets: string[]) {
  const prefix = at(dir, "debug");
  return outputs.flatMap((p) => p !== prefix && !p.startsWith(prefix + "/") ? [p] :
    (targets.length ? targets : [""]).map((target) => at(dir, [target.split("/").at(-1)?.replace(/\.json$/u, ""), profile].filter(Boolean).join("/")) + p.slice(prefix.length))).slice(0, 16);
}

export function preparation(root: string, t: ProjectTarget, tool: Tool, force = false): { cwd: string; invocation: Invocation }[] {
  const manager = t.tauri?.manager ?? t.adapter;
  const install = t.install;
  if (!install || (manager !== "npm" && manager !== "pnpm") || (!force && !install.required.length)) return [];
  const cwd = resolveWithin(root, install.cwd);
  if (!force && dependenciesReady(root, cwd, install, manager)) return [];
  const args = manager === "npm"
    ? [install.lock ? "ci" : "install", "--include=dev"]
    : ["install", "--prod=false", ...(install.lock ? ["--frozen-lockfile"] : [])];
  return [{ cwd: install.cwd, invocation: { executable: tool.executable, args, cwd, env: tool.env } }];
}

function fileTime(path: string) {
  try { const stat = statSync(path); return stat.isFile() ? stat.mtimeMs : -Infinity; }
  catch { return -Infinity; }
}

function dependenciesReady(root: string, cwd: string, install: NonNullable<ProjectTarget["install"]>, manager: "npm" | "pnpm") {
  const lockTime = install.lock ? fileTime(join(cwd, install.lock)) : -Infinity;
  const metadata = manager === "npm" ? ["node_modules/.package-lock.json"] : ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"];
  const installedAt = Math.max(...metadata.map((path) => fileTime(join(cwd, path))));
  if (manager === "pnpm") {
    const pnp = Math.max(fileTime(join(cwd, ".pnp.cjs")), fileTime(join(cwd, ".pnp.js")));
    const inputs = [...new Set([cwd, ...install.required.map(({ from }) => resolveWithin(root, from))])];
    const declaredAt = Math.max(lockTime, fileTime(join(cwd, "pnpm-workspace.yaml")), ...inputs.flatMap((dir) => [fileTime(join(dir, ".npmrc")), fileTime(join(dir, "package.json"))]));
    if (pnp !== -Infinity && pnp >= declaredAt) return true;
  }
  return install.required.every(({ from, name, version }) => {
    for (const parent of ancestors(from)) {
      try {
        const path = realpathSync(join(root, parent, "node_modules", name, "package.json"));
        if (!inside(root, path)) return false;
        const data = JSON.parse(readBounded(path, 256 * 1024)) as { version?: unknown };
        const range = validRange(version);
        return (!range || (typeof data?.version === "string" && matchesVersion(data.version, range))) && Math.max(installedAt, fileTime(path)) >= lockTime;
      } catch (error) {
        // A missing package can be hoisted; an invalid or unreadable nearer one cannot.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      if (parent === install.cwd) break;
    }
    return false;
  });
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
    const cv = (await checkedCommand({ cwd: tmpdir(), env: tool.env, executable: cmake, args: ["--version"] }, owned, accept)).split("\n")[0] ?? "";
    const found = /^cmake version (\d+\.\d+\.\d+)/u.exec(cv)?.[1];
    if (!found || !matchesVersion(found, t.cmake.preset ? ">=3.19" : ">=3.14") || !matchesMiseVersion(found, t.requirements.miseCmake)) {
      throw new Error("CMake 版本不支持所选配置，或与 mise 声明不符");
    }
    return cv;
  }
  if (t.adapter === "cargo" || t.tauri) {
    const offset = t.tauri?.manager ? 2 : 0;
    const [cargo, rustc] = tool.candidate.paths.slice(offset);
    if (!cargo || !rustc) throw new Error("缺少 Cargo 或 rustc");
    const common = { cwd: tmpdir(), env: tool.env, args: ["--version"] };
    const cv = await checkedCommand({ ...common, executable: cargo }, owned, accept);
    const rv = await checkedCommand({ ...common, executable: rustc }, owned, accept);
    const found = /^rustc (\d+\.\d+\.\d+)/u.exec(rv)?.[1];
    if (!found || !matchesVersion(found, t.requirements.rust && `>=${t.requirements.rust}`)) throw new Error(`Rust 版本不符合要求：${rv.slice(0, 80)}`);
    const rust = `${cv.split(" ").slice(0, 2).join(" ")} · ${rv.split(" ").slice(0, 2).join(" ")}`;
    if (!t.tauri) return rust;
    const js = t.tauri.manager && await verifyJs(t, tool, owned, accept, t.tauri.manager);
    const xcrun = tool.tauriSdkCheck;
    let sdk: string | undefined;
    if (xcrun) {
      sdk = await checkedCommand({ ...common, executable: xcrun, args: ["--sdk", "macosx", "--show-sdk-path"] }, owned, accept);
      if (!isAbsolute(sdk) || !statSync(sdk).isDirectory()) throw new Error("未确认 macOS SDK");
    }
    const cliVersion = tool.tauriCargoCli && await checkedCommand({ ...common, executable: cargo, args: ["tauri", "--version"] }, owned, accept);
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
