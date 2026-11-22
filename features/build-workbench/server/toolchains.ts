import { lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { satisfies, valid, validRange } from "semver";
import { parse as yaml } from "yaml";
import type { Candidate, Configuration } from "../shared/contracts";
import { at, digest, inside, missing, readBounded, readText, resolveWithin } from "./paths";
import { autoInstallRisk, directories, executable, executables, installedExecutables, matchesInstalledAlias } from "./mise";
import { cargoOptions, cmakeOptions, gradleOptions, tauriOptions, validateOptions, xcodeOptions } from "./options";
import { launch } from "./process";
import type { Bindings, Invocation, OwnedProcess } from "./process";
import { cargoContext } from "./rust-projects";
import { cmakeBuildDir } from "./cmake";
import { object, tauriConfig, type ProjectTarget } from "./projects";
import { resolveTauriCli, type TauriCliRequest } from "./tauri-cli";
import { gradleJvmOverride, gradleRuntime, javaRelease } from "./gradle-runtime.ts";

export type Tool = { candidate: Candidate; signature: string; executable: string; env: NodeJS.ProcessEnv; bindings?: Bindings; overrides?: string[]; tauriCargoCli?: string; gradlePersistent?: boolean; pnpmMajor?: number };
type VerifiedTool = { version: string; pnpmMajor?: number };
export type Checks = Map<string, VerifiedTool>;

export function identity(path: string) {
  const s = statSync(path, { bigint: true });
  return [path, realpathSync(path), s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}

export function requirement(t: ProjectTarget) {
  if (t.xcode) return "完整 Xcode · iPhone Simulator SDK";
  if (t.gradle) return `${t.gradle.wrapper ? "项目 Gradle Wrapper" : "Gradle"} · 启动 Java 与运行 Gradle 的 JVM 可能不同`;
  if (t.cmake) return "CMake ≥ 3.14 · 生成器和编译器由配置检查";
  if (t.tauri) return [t.tauri.manager && jsRequirement(t, t.tauri.manager), "Cargo + rustc", t.tauri.cli ? "项目声明的 Tauri CLI" : "cargo-tauri", "平台构建依赖"].filter(Boolean).join(" · ");
  if (t.adapter === "cargo") return `Cargo + rustc${t.requirements.rustChannel ? " · " + t.requirements.rustChannel : ""}${t.requirements.rust ? " · Rust >=" + t.requirements.rust : ""}`;
  return jsRequirement(t, t.adapter);
}

function jsRequirement(t: ProjectTarget, manager: string) {
  return `Node ${[t.requirements.miseNode, t.requirements.node].filter(Boolean).join(" 且 ") || "（项目未指定版本）"} · ${manager} ${[t.requirements.miseManager, t.requirements.manager, t.requirements.managerEngine].filter(Boolean).join(" 且 ") || "（项目未指定版本）"}`;
}

function makeTool(t: ProjectTarget, checked: Checks, paths: string[], executable: string, env: NodeJS.ProcessEnv, label: string, bindings?: Bindings, overrides?: string[], gradleContext?: unknown): Tool {
  const id = digest(JSON.stringify(paths)).slice(0, 32);
  const cmakeSelection = t.cmake && [env.CMAKE_GENERATOR, env.CMAKE_GENERATOR_PLATFORM, env.CMAKE_GENERATOR_TOOLSET, env.CMAKE_GENERATOR_INSTANCE, env.CMAKE_TOOLCHAIN_FILE, env.CC, env.CXX];
  const signature = digest(JSON.stringify([t.requirements, gradleContext, t.xcode, cmakeSelection, env.PATH, env.JAVA_HOME, env.ANDROID_HOME, env.DEVELOPER_DIR, env.GRADLE_USER_HOME, env.JAVA_TOOL_OPTIONS, env.PROTOC,
    ...[...new Set([...paths, ...Object.values(bindings ?? {})])].map(identity)]));
  const check = checked.get(signature);
  const runEnv = check?.pnpmMajor === undefined ? env : fixedPnpmEnvironment(env, check.pnpmMajor);
  return { candidate: { id, paths, label, requirement: requirement(t), version: check?.version }, executable, env: runEnv, signature, bindings, overrides, pnpmMajor: check?.pnpmMajor };
}

function rustPairs(t: ProjectTarget, env: NodeJS.ProcessEnv) {
  const rust = env.RUSTUP_HOME ?? join(env.HOME ?? homedir(), ".rustup");
  if (t.requirements.rustIssue) return [];
  const dirs = t.requirements.rustPath ? [join(t.requirements.rustPath, "bin")] :
    [...directories(join(rust, "toolchains")).map((p) => join(p, "bin")), ...installedExecutables("cargo", env).map(dirname)];
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
  if (t.requirements.rustIssue) issues.push(t.requirements.rustIssue);
  if (t.requirements.rustPath && !rustPairs(t, env).length) issues.push(`Rust 路径固定到 ${t.requirements.rustPath}，其中未找到 Cargo 和 rustc。`);
  if (t.requirements.rustChannel && !rustPairs(t, env).length) issues.push(`未安装项目固定的 Rust 工具链：${t.requirements.rustChannel}。`);
  if (t.xcode && !xcodeExecutables(env).length) issues.push("没有找到完整 Xcode；仅安装 Command Line Tools 无法构建 iPhone Simulator 产物。");
  if (t.gradle && !t.gradle.wrapper && !installedExecutables("gradle", env).length) issues.push("未找到 Gradle Wrapper 或已安装的 Gradle。");
  return issues;
}

function optionalIdentity(path: string) {
  try { return identity(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code ?? "unavailable"; }
}

function gradleEnvironment(env: NodeJS.ProcessEnv, cwd: string) {
  const home = resolve(cwd, env.GRADLE_USER_HOME || join(env.HOME || homedir(), ".gradle"));
  const initDir = join(home, "init.d");
  const init: string[] = [];
  try {
    const dir = opendirSync(initDir);
    try {
      for (let item, count = 0; (item = dir.readSync());) {
        if (count++ === 128) { init.push("truncated"); break; }
        if (/\.gradle(?:\.kts)?$/u.test(item.name)) init.push(optionalIdentity(join(initDir, item.name)));
      }
    } finally { dir.closeSync(); }
  } catch (error) { init.push((error as NodeJS.ErrnoException).code ?? "unavailable"); }
  const variables = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  const declarations = ["gradle.properties", "init.gradle", "init.gradle.kts"].map((file) => optionalIdentity(join(home, file)));
  const safe = isAbsolute(env.HOME ?? "") && declarations.every((entry) => entry === "ENOENT") &&
    init.every((entry) => entry === "ENOENT") && !["GRADLE_OPTS", "JAVA_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "BASH_ENV", "ENV"].some((key) => env[key]) &&
    !Object.keys(env).some((key) => /^ORG_GRADLE_PROJECT_org\.gradle\./u.test(key));
  return { home, identity: [home, variables, optionalIdentity(initDir), ...init.sort(), ...declarations], safe };
}

function gradleDistribution(launcher: string) {
  const real = realpathSync(launcher);
  const home = dirname(dirname(real));
  const files: string[] = [];
  let safe = true;
  let launcherJar = false;
  function visit(path: string, depth: number) {
    if (depth > 8 || files.length >= 2048) throw new Error("Gradle 安装超出可追踪范围");
    const item = lstatSync(path);
    if (item.isSymbolicLink()) throw new Error("Gradle 安装包含链接");
    files.push(identity(path));
    if (!item.isDirectory()) {
      if (/\/lib\/gradle-launcher-[^/]+\.jar$/u.test(path)) launcherJar = true;
      return;
    }
    const dir = opendirSync(path);
    try { for (let entry; (entry = dir.readSync());) visit(join(path, entry.name), depth + 1); }
    finally { dir.closeSync(); }
  }
  try {
    for (const segment of ["lib", "init.d"]) {
      const path = join(home, segment);
      if (optionalIdentity(path) !== "ENOENT") visit(path, 0);
      if (segment === "init.d" && files.some((file) => /\/init\.d\/.*\.gradle(?:\.kts)?:/u.test(file))) safe = false;
    }
  } catch { safe = false; }
  return { identity: files.sort(), safe: safe && launcherJar && real === join(home, "bin/gradle") };
}

function nativeTools(t: ProjectTarget, env: NodeJS.ProcessEnv, checked: Checks, root: string): Tool[] {
  if (t.xcode) {
    return xcodeExecutables(env).map((xcode) => {
      const developer = xcodeDeveloperDir(xcode);
      return makeTool(t, checked, [xcode], xcode, { ...env, DEVELOPER_DIR: developer, XCODE_XCCONFIG_FILE: undefined }, `Xcode · ${xcode}`, undefined,
        [`DEVELOPER_DIR=${developer}`, ...(env.XCODE_XCCONFIG_FILE === undefined ? [] : ["不继承 XCODE_XCCONFIG_FILE，防止覆盖无签名和输出设置"])]);
    });
  }
  if (!t.gradle) return [];
  const wrapper = t.gradle.wrapper ? resolveWithin(root, t.gradle.wrapper) : undefined;
  const jar = t.gradle.jar ? resolveWithin(root, t.gradle.jar) : undefined;
  const gradles = wrapper ? [wrapper] : installedExecutables("gradle", env);
  const preferred = env.JAVA_HOME && isAbsolute(env.JAVA_HOME) ? executables("java", { PATH: join(env.JAVA_HOME, "bin") }) : [];
  const systemJdks = process.platform === "darwin" ? directories("/Library/Java/JavaVirtualMachines").map((dir) => join(dir, "Contents/Home/bin/java")) : [];
  const javaExecutables = [...new Set([...preferred, ...installedExecutables("java", env, t.requirements.miseJava), ...systemJdks])]
    .filter((path) => executable(path) && (process.platform !== "darwin" || realpathSync(path) !== "/usr/bin/java") && !autoInstallRisk(path));
  const context = gradleEnvironment(env, resolveWithin(root, t.cwd));
  const override = gradleJvmOverride(root, t.cwd, context.home, env);
  // A project-controlled Wrapper may pick a different or customized distribution.
  // Do not promote its result to a persistent record without a verified launcher chain.
  const distributions = new Map(gradles.map((gradle) => [gradle, wrapper ? undefined : gradleDistribution(gradle)]));
  return javaExecutables.flatMap((java) => gradles.map((gradle) => {
    const javaHome = dirname(dirname(realpathSync(java)));
    // Gradle's native daemon can detach; keep launcher and forked JVM integration disabled.
    const runEnv = { ...env, JAVA_HOME: javaHome, JAVA_TOOL_OPTIONS: [env.JAVA_TOOL_OPTIONS, "-Dorg.gradle.native=false"].filter(Boolean).join(" ") };
    const distro = distributions.get(gradle);
    const javaFiles = ["release", "lib/modules", "lib/server/libjvm.dylib", "lib/server/libjvm.so"].map((file) => optionalIdentity(join(javaHome, file)));
    const tool = makeTool(t, checked, [java, gradle, ...(jar ? [jar] : [])], gradle, runEnv,
      `${wrapper ? "Gradle Wrapper" : "Gradle"} · ${javaHome}`, { java }, [`JAVA_HOME=${javaHome}`, "JAVA_TOOL_OPTIONS 追加 -Dorg.gradle.native=false，让 Gradle 单次运行留在可停止的进程组中"],
      [context.identity, !!wrapper, distro?.identity, javaFiles, t.gradle?.distributionVersion, override]);
    tool.candidate.gradleRuntime = gradleRuntime(t.gradle?.distributionVersion, javaRelease(javaHome), override);
    return { ...tool, gradlePersistent: context.safe && !!distro?.safe && javaFiles.slice(0, 2).every((value) => isAbsolute(value)) && javaFiles.slice(2).some((value) => isAbsolute(value)) };
  })).slice(0, 32);
}

export function toolchains(t: ProjectTarget, env: NodeJS.ProcessEnv, checked: Checks, root: string): Tool[] {
  if (t.gradle || t.xcode) return nativeTools(t, env, checked, root);
  if (t.cmake) {
    const bindings = helperBinding("ninja", env);
    return installedExecutables("cmake", env, t.requirements.miseCmake).map((cmake) =>
      makeTool(t, checked, [cmake], cmake, env, `CMake · ${dirname(cmake)}`, bindings));
  }
  if (t.adapter === "cargo" || t.tauri) {
    const tauri = t.tauri;
    const rustCli = tauri && !tauri.manager ? executables("cargo-tauri", { PATH: join(env.CARGO_HOME ?? join(env.HOME ?? homedir(), ".cargo"), "bin") })[0] ?? installedExecutables("cargo-tauri", env)[0] : undefined;
    if (tauri && !tauri.manager && !rustCli) return [];
    const helpers = !env.PROTOC ? helperBinding("protoc", env) : {};
    const js = tauri?.manager ? jsTools(t, env, tauri.manager) : [];
    return rustPairs(t, env).flatMap(({ cargo, rustc, bin }) => {
      const bindings = { ...helpers, cargo, rustc, ...(rustCli ? { "cargo-tauri": rustCli } : {}) };
      const paths = [cargo, rustc, ...(rustCli ? [rustCli] : [])];
      if (!tauri) return [makeTool(t, checked, paths, cargo, env, `Cargo · ${bin}`, bindings)];
      if (!tauri.manager) return [{ ...makeTool(t, checked, paths, cargo, env, `Tauri · ${bin}`, bindings), tauriCargoCli: rustCli }];
      // Tauri's JS CLI launches Cargo by name. Bind it independently of npm/pnpm's install directory.
      return js.map(({ node, manager, env: runtime, bindings: jsBindings, overrides: jsOverrides }) =>
        makeTool(t, checked, [node, manager, ...paths], manager, runtime, `Tauri · ${tauri.manager} · ${bin} · ${dirname(node)} → ${dirname(manager)}`,
          { ...jsBindings, ...bindings }, jsOverrides));
    });
  }
  if (t.adapter !== "npm" && t.adapter !== "pnpm") return [];
  return jsTools(t, env, t.adapter).map(({ node, manager, env: runEnv, bindings, overrides }) => makeTool(t, checked,
    [node, manager], manager, runEnv, `${t.adapter} · ${dirname(node)} → ${dirname(manager)}`, bindings, overrides));
}

function* ancestorBins(cwd: string) {
  for (let dir = cwd;; dir = dirname(dir)) {
    yield join(dir, "node_modules", ".bin");
    if (dirname(dir) === dir) return;
  }
}

// npm/pnpm prepend local package bins after launch. Direct Tauri launches
// use the explicitly planned hook paths instead of an unrelated install dir.
export function assertPackageBindings(invocation: Invocation) {
  const bindings = invocation.bindings;
  if (!bindings?.node) return;
  for (const dir of invocation.scriptBins ?? ancestorBins(invocation.cwd)) {
    const names = invocation.scriptBins ? Object.keys(bindings) : ["node", ...(bindings.cargo ? ["cargo", "rustc"] : [])];
    for (const name of names) {
      const path = join(dir, name);
      if (executable(path) && realpathSync(path) !== realpathSync(bindings[name]!)) {
        throw new Error(`项目的 ${path} 会覆盖所选 ${name}；请检查项目的运行时配置`);
      }
    }
  }
}

function tauriScriptBins(root: string, cwd: string, request: TauriCliRequest, manager: string) {
  const native = realpathSync(manager);
  const base = dirname(native);
  const bundled = request.manager === "npm" ? [join(base, "../node_modules/@npmcli/run-script/lib/node-gyp-bin"),
    join(base, "../lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin"), join(base, "node-gyp-bin")] :
    [join(base, "dist/node-gyp-bin"), join(base, "node-gyp-bin"), join(base, "../dist/node-gyp-bin")];
  const available = (path: string) => {
    try { return statSync(path).isDirectory(); }
    catch (error) { if (!missing(error)) throw error; return false; }
  };
  const nodeGyp = bundled.find(available);
  const bundledPaths = nodeGyp ? [nodeGyp] : [];
  const local = (path: string) => resolveWithin(root, relative(root, path));
  if (request.manager === "pnpm") {
    const member = local(join(cwd, "node_modules/.bin"));
    const workspace = local(join(resolveWithin(root, request.install), "node_modules/.bin"));
    return [...new Set([member, ...bundledPaths, workspace])];
  }
  const paths: string[] = [];
  for (const path of ancestorBins(cwd)) {
    if (inside(root, path)) paths.push(local(path));
    else if (available(path)) throw new Error(`npm 钩子会搜索工作区外的 ${path}；无法确认项目工具范围`);
  }
  return [...paths, ...bundledPaths];
}

function helperBinding(name: string, env: NodeJS.ProcessEnv): Bindings {
  const host = executables(name, env)[0];
  if (host && !autoInstallRisk(host)) return {};
  const helper = installedExecutables(name, env)[0];
  return helper ? { [name]: helper } : {};
}

const configKey = (name: string) => name.toLowerCase().replace(/\[\]$/u, "").replace(/[-_]/gu, "");
const envOption = (name: string, nativePnpm: boolean) => {
  const key = name.toLowerCase();
  if (key.startsWith("npm_config_")) return key.slice("npm_config_".length);
  if (nativePnpm && key.startsWith("pnpm_config_")) return key.slice("pnpm_config_".length);
};
const runtimeSetting = (name: string) => /^(?:usenodeversion|nodeversionforrun|nodeoptionsforrun)$/u.test(configKey(name));
const pnpmSelectors = /^(?:workspace|workspaceroot|workspacedir|workspaceprefix|workspacepackages|dir|filter|filterprod|prefix)$/u;
const pnpmLayout = /^(?:lockfiledir|modulesdir|virtualstoredir|globalvirtualstoredir)$/u;
const pnpmYamlSwitch = /^(?:global|ignoreWorkspace|recursive|lockfileOnly|recursiveInstall|sharedWorkspaceLockfile|enableGlobalVirtualStore|virtualStoreType)$/u;
const pnpmSwitch = /^(?:global|ignoreworkspace|recursive|lockfileonly|recursiveinstall|sharedworkspacelockfile|enableglobalvirtualstore|virtualstoretype)$/u;
const pnpmYamlLayout = /^(?:lockfileDir|modulesDir|virtualStoreDir|globalVirtualStoreDir)$/u;
const pnpmNativeEnv = /^(?:pnpm_config_[a-z0-9]+(?:_[a-z0-9]+)*|PNPM_CONFIG_[A-Z0-9]+(?:_[A-Z0-9]+)*)$/u;

function managerFile(cwd: string, file: string) {
  try { return readBounded(realpathSync(resolve(cwd, file)), 512 * 1024); }
  catch (error) { if (!missing(error)) throw new Error(`无法验证包管理器配置：${file}`, { cause: error }); }
}

function* npmrcEntries(cwd: string, file: string) {
  for (const line of managerFile(cwd, file)?.split(/\r?\n/u) ?? []) {
    const entry = /^\s*([\w-]+(?:\[\])?)\s*=\s*(.*?)\s*$/u.exec(line);
    if (entry?.[1] !== undefined && entry[2] !== undefined) yield [entry[1], entry[2]] as const;
  }
}

function assertPnpmConfig(root: string, t: ProjectTarget, tool: Tool, phase: "install" | "script", cwd: string, userHome: string, config: Map<string, string | undefined>) {
  const install = resolveWithin(root, t.install?.cwd ?? t.cwd);
  const modern = tool.pnpmMajor === undefined || tool.pnpmMajor >= 11;
  const skipMember = phase === "install" && t.install?.workspace && install !== resolveWithin(root, t.cwd);
  const reject = (source: string, label: string, reason: string) => {
    throw new Error(`${source} 的 ${label} 可改变 pnpm 执行范围；${reason}`);
  };
  const check = (name: string, source: string, label = name) => {
    if (runtimeSetting(name)) throw new Error(`${source} 可能替换脚本 Node，无法验证所选运行时`);
    if (pnpmSelectors.test(configKey(name))) reject(source, label, "请移除目标或目录覆盖后重试");
  };
  type Setting = { source: string; label: string; value: unknown };
  const effective = new Map<string, Setting>();
  const iniBoolean = (value: string) => value === "true" ? true : value === "false" ? false : value;
  const checkSwitch = (key: string, { source, label, value }: Setting) => {
    if (key === "virtualstoretype") {
      if (value !== "project") reject(source, label, "只支持项目内的虚拟存储");
      return;
    }
    if (typeof value !== "boolean") reject(source, label, "请使用明确的布尔值 true 或 false");
    if (key === "sharedworkspacelockfile" || (key === "recursiveinstall" && (!skipMember || value === true))) return;
    if (key === "recursiveinstall") reject(source, label, "从根目录准备依赖可能跳过所选成员，请启用递归安装");
    if (value === true) reject(source, label, "请使用本地工作区及默认安装范围");
  };
  const scan = (file: string, user = false) => {
    for (const [name, value] of npmrcEntries(cwd, file)) {
      const key = configKey(name);
      // A user npm prefix is for global npm installs. Modern pnpm doesn't
      // read it, and it doesn't select the local install root in legacy mode.
      if (user && key === "prefix") continue;
      check(name, file);
      if (pnpmLayout.test(key)) reject(file, name, "无法确认兼容配置指定的依赖布局");
      if (!pnpmSwitch.test(key)) continue;
      const setting = { source: file, label: name, value: iniBoolean(value) };
      if (!modern) effective.set(key, setting);
      else if (key !== "recursiveinstall" && key !== "sharedworkspacelockfile") checkSwitch(key, setting);
    }
  };
  const configDir = tool.env.XDG_CONFIG_HOME ? join(tool.env.XDG_CONFIG_HOME, "pnpm") :
    join(userHome, process.platform === "darwin" ? "Library/Preferences/pnpm" : ".config/pnpm");
  const global = readYaml(managerFile(cwd, join(configDir, "config.yaml")), "全局 pnpm config.yaml");
  const project = readYaml(readText(root, at(t.install?.cwd ?? t.cwd, "pnpm-workspace.yaml")), "pnpm-workspace.yaml");
  function readYaml(text: string | undefined, source: string) {
    try { return text === undefined ? {} : object(yaml(text, { maxAliasCount: 0 })); }
    catch { throw new Error(`无法读取 ${source} 的 pnpm 配置`); }
  }
  function record(doc: Record<string, unknown>, source: string) {
    for (const [name, value] of Object.entries(doc)) {
      const key = configKey(name);
      check(name, source);
      // Native YAML settings are camelCase. An ignored spelling must not mask
      // a value from the other YAML file or from the environment.
      if (pnpmYamlSwitch.test(name) || pnpmYamlLayout.test(name)) effective.set(key, { source, label: name, value });
    }
  }
  record(global, "全局 pnpm config.yaml");
  scan(config.get("npm_config_globalconfig") ?? join(dirname(dirname(tool.executable)), "etc/npmrc"));
  scan(join(configDir, "rc"));
  scan(config.get("npm_config_userconfig") ?? join(userHome, ".npmrc"), true);
  if (config.get("pnpm_config_userconfig")) scan(config.get("pnpm_config_userconfig")!, true);
  if (config.get("pnpm_config_globalconfig")) scan(config.get("pnpm_config_globalconfig")!);
  scan(join(install, ".npmrc"));
  if (cwd !== install) scan(join(cwd, ".npmrc"));
  record(project, "pnpm-workspace.yaml");
  if (tool.pnpmMajor === undefined || tool.pnpmMajor >= 12) {
    for (const authorized of Object.values(object(project.include))) {
      if (authorized === "*" || (Array.isArray(authorized) && authorized.some((name: unknown) => typeof name === "string" &&
        (name === "packages" || name === "packageConfigs" || pnpmSelectors.test(configKey(name)) || pnpmLayout.test(configKey(name)) || pnpmSwitch.test(configKey(name)) || runtimeSetting(name))))) {
        reject("pnpm-workspace.yaml", "include", "暂不支持从其他文件或配置依赖委托工作区成员或安装范围");
      }
    }
  }
  const environment = new Map<string, Setting>();
  for (const [label, value] of Object.entries(tool.env)) if (value !== undefined) {
    const option = envOption(label, true);
    if (!option) continue;
    const key = configKey(option);
    check(option, "宿主环境", label);
    if (pnpmLayout.test(key) || pnpmSwitch.test(key)) {
      const setting = { source: "宿主环境", label, value: iniBoolean(value) };
      if (modern ? pnpmNativeEnv.test(label) : label.toLowerCase().startsWith("npm_config_")) {
        const other = environment.get(key);
        if (other && other.value !== setting.value) reject(setting.source, label, "同一选项有多个不一致的环境变量");
        environment.set(key, setting);
      } else if (pnpmLayout.test(key)) reject(setting.source, label, "无法确认兼容环境变量指定的依赖布局");
      else if (key !== "recursiveinstall" && key !== "sharedworkspacelockfile") checkSwitch(key, setting);
    }
  }
  for (const [key, setting] of environment) effective.set(key, setting);
  const shared = effective.get("sharedworkspacelockfile")?.value !== false;
  for (const [key, setting] of effective) {
    if (pnpmSwitch.test(key)) checkSwitch(key, setting);
    else if (!(key === "lockfiledir" && shared && setting.value === install)) {
      reject(setting.source, setting.label, "只支持在已确认的安装根或其成员中使用原生依赖布局");
    }
  }
  // Separate lockfiles activate per-package layout, including redirected
  // modules directories. Do not turn this into a second membership resolver.
  const memberSettings = project.packageConfigs ?? global.packageConfigs;
  const memberEntries: unknown[] = Array.isArray(memberSettings) ? memberSettings : Object.values(object(memberSettings));
  if (!shared) for (const entry of memberEntries) {
    for (const [name, value] of Object.entries(object(entry))) {
      const source = "pnpm-workspace.yaml packageConfigs";
      check(name, source);
      if (pnpmLayout.test(configKey(name))) reject(source, name, "无法确认成员使用自定义目录后的依赖布局");
      if (pnpmSwitch.test(configKey(name))) checkSwitch(configKey(name), { source, label: name, value });
    }
  }
}

export function assertJsConfig(root: string, t: ProjectTarget, tool: Tool, phase: "install" | "script") {
  const { env } = tool;
  const cwd = resolveWithin(root, phase === "install" ? t.install?.cwd ?? t.cwd : t.cwd);
  const config = new Map(Object.entries(env).map(([name, value]) => [name.toLowerCase(), value]));
  const userHome = env.HOME || homedir();
  if ((t.tauri?.manager ?? t.adapter) === "pnpm") return assertPnpmConfig(root, t, tool, phase, cwd, userHome, config);
  const check = (name: string, source: string, label = name) => {
    if (runtimeSetting(name)) throw new Error(`${source} 可能替换脚本 Node，无法验证所选运行时`);
    if (/^(?:workspace|workspaces|includeworkspaceroot|prefix|global|location)$/u.test(configKey(name))) {
      throw new Error(`${source} 的 ${label} 可改变 npm 执行范围；请在工作台选择目标，移除此覆盖后重试`);
    }
  };
  for (const [label, value] of Object.entries(env)) if (value !== undefined) {
    const option = envOption(label, false);
    if (option) check(option, "宿主环境", label);
  }
  const scan = (file: string, npmUser = false) => {
    const locations = new Map<string, string>();
    for (const [name, value] of npmrcEntries(cwd, file)) {
      if (npmUser && name === "prefix") locations.set(name, value);
      else check(name, file);
      if (name === "globalconfig" || name === "userconfig") locations.set(name, value);
    }
    return locations;
  };
  const projectFile = join(resolveWithin(root, t.install?.cwd ?? t.cwd), ".npmrc");
  const project = scan(projectFile);
  if (join(cwd, ".npmrc") !== projectFile) scan(join(cwd, ".npmrc"));
  // npm reads its local project before the user's config. A user prefix only
  // controls global installs and the location of the global npmrc in local mode.
  const expand = (value: string) => {
    let expanded = value.replace(/\s+[;#].*$/u, "").replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2")
      .replace(/\$\{([\w]+)\}/gu, (_, name: string) => env[name] ?? "${" + name + "}");
    if (expanded.startsWith("~/")) expanded = join(userHome, expanded.slice(2));
    if (!expanded || /[\\$'"\x00-\x1f]/u.test(expanded)) throw new Error("无法确认 npm 用户前缀或全局配置路径");
    return resolve(cwd, expanded);
  };
  const userPath = config.get("npm_config_userconfig") || project?.get("userconfig");
  const user = scan(userPath ? expand(userPath) : join(userHome, ".npmrc"), true);
  const nodeHome = dirname(dirname(tool.bindings?.node || tool.candidate.paths[0] || tool.executable));
  const prefix = user?.get("prefix");
  const global = config.get("npm_config_globalconfig") || project?.get("globalconfig") || user?.get("globalconfig");
  const defaultPrefix = env.PREFIX || (env.DESTDIR ? join(env.DESTDIR, nodeHome) : nodeHome);
  scan(global ? expand(global) : join(prefix === undefined ? defaultPrefix : expand(prefix), "etc/npmrc"));
}

function fixedPnpmEnvironment(env: NodeJS.ProcessEnv, major: number): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of Object.keys(result)) {
    const option = envOption(name, true);
    if (option && /^(?:pmonfail|managepackagemanagerversions|packagemanagerstrict(?:version)?)$/u.test(configKey(option))) delete result[name];
  }
  // pnpm 11+ uses pmOnFail; older releases use the npmrc-compatible switches.
  // The selected version has already passed packageManager/engines/mise validation.
  return major >= 11 ? { ...result, pnpm_config_pm_on_fail: "ignore" } :
    { ...result, npm_config_manage_package_manager_versions: "false", npm_config_package_manager_strict_version: "true" };
}

function jsTools(t: ProjectTarget, env: NodeJS.ProcessEnv, name: "npm" | "pnpm") {
  return installedExecutables("node", env, t.requirements.miseNode).flatMap((node) =>
    installedExecutables(name, env, t.requirements.miseManager ?? t.requirements.manager).map((manager) => ({ node, manager,
      bindings: { node, [name]: manager },
      overrides: name === "pnpm" ? ["pnpm 使用已选安装，不切换包管理器版本"] : [],
      env,
    }))).slice(0, 32);
}

export function matchesVersion(found: string, range: string | undefined): boolean {
  const value = valid(found) ?? (/^\d+\.\d+$/u.test(found) ? valid(found + ".0") : null);
  return !!value && (!range || satisfies(value, range, { includePrerelease: true }));
}

function matchesMiseVersion(found: string, pin: string | undefined, name: string, binary: string, env: NodeJS.ProcessEnv) {
  if (!pin) return true;
  return validRange(pin) === null ? matchesInstalledAlias(name, pin, binary, env) : matchesVersion(found, pin);
}

function rustContext(root: string, cwd: string, owner: string, tool: Tool) {
  const context = cargoContext(root, cwd, owner, tool.env, tool.bindings?.rustc);
  if (context.compiler && (!tool.bindings?.rustc || context.compiler !== realpathSync(tool.bindings.rustc))) {
    throw new Error(`Cargo 实际编译器 ${context.compiler} 与所选 rustc 不一致；请选择相同工具或调整项目声明`);
  }
  return context;
}

export function buildArguments(root: string, t: ProjectTarget, opts: Configuration["options"], tool: Tool) {
  if (t.xcode) {
    validateOptions(() => xcodeOptions(opts, !!t.operation));
    const container = [`-${t.xcode.kind}`, resolveWithin(root, t.project)];
    if (t.operation === "probe") return { args: ["-list", "-json", ...container, ...opts], outputs: [] };
    return { args: [...container, "-scheme", t.name, "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
      "-derivedDataPath", resolveWithin(root, t.xcode.derived), ...opts, "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "build"], outputs: [] };
  }
  if (t.gradle) {
    const selected = validateOptions(() => gradleOptions(opts, !!t.operation));
    return { args: ["--no-daemon", "--console=plain", ...(t.operation ? ["tasks", "--all"] : [t.name]), ...selected.forwarded], outputs: [], nativeOptions: selected.context, taskFilter: selected.filter };
  }
  if (t.cmake) {
    const chosen = validateOptions(() => cmakeOptions(opts, !!t.operation));
    if (t.operation === "probe") {
      const config = t.cmake.preset ? ["--preset", t.cmake.preset] : [];
      const dir = cmakeBuildDir(t.cmake.dir, tool.signature, opts);
      return { args: [...config, ...opts, "-S", resolveWithin(root, t.cwd), "-B", resolveWithin(root, dir)], outputs: [], configureDir: dir };
    }
    if (t.cmake.tool !== tool.signature || !t.cmake.target) throw new Error("构建目录使用了另一套工具或工具已变化，请用当前组合重新配置");
    if (chosen && !Object.hasOwn(t.cmake.configurations ?? {}, chosen)) throw new Error(`当前 File API 未列出此目标的 ${chosen} 配置`);
    const config = chosen ?? t.cmake.defaultConfig;
    const writes = t.cmake.writePaths ?? {};
    const sharedWrites = config === undefined ? Object.values(writes).flat() : writes[config] ?? [];
    return { args: ["--build", resolveWithin(root, t.cmake.dir), "--target", t.cmake.target, ...opts], outputs: chosen ? t.cmake.configurations![chosen]! : t.outputs, sharedWrites };
  }
  if (t.tauri) {
    const selected = validateOptions(() => tauriOptions(root, t.cwd, opts));
    const cwd = resolveWithin(root, t.cwd);
    if (t.tauri.manager) assertJsConfig(root, t, tool, "script");
    const bindings = { TAURI_APP_PATH: resolveWithin(root, t.project), TAURI_FRONTEND_PATH: resolveWithin(root, t.tauri.frontend) };
    for (const [name, path] of Object.entries(bindings)) {
      const value = tool.env[name];
      if (value === undefined) continue;
      const supplied = resolve(cwd, value);
      if (!value || !inside(root, supplied) || resolveWithin(root, relative(root, supplied) || ".") !== path || supplied !== path) {
        throw new Error(`${name} 与所选 Tauri 应用或前端目录冲突；请移除覆盖后重试`);
      }
    }
    if (tool.env.TAURI_CONFIG !== undefined) throw new Error("无法确认宿主 TAURI_CONFIG 叠加；请使用项目内的 --config 文件");
    const platformFiles = ["windows", "linux", "macos", "android", "ios"].flatMap((name) =>
      [`tauri.${name}.conf.json`, `tauri.${name}.conf.json5`, `Tauri.${name}.toml`].map((file) => at(t.project, file)));
    const explicit = selected.overlays.map((path) => at(t.cwd, path));
    const inputs = [...platformFiles, ...explicit].map((path) => {
      const text = readText(root, path);
      if (text === undefined && explicit.includes(path)) throw new Error(`Tauri 叠加配置不存在：${path}`);
      if (text !== undefined) tauriConfig(path, text);
      return [path, text === undefined ? null : digest(text)];
    });
    const tauriCli: TauriCliRequest | undefined = t.tauri.manager && t.tauri.cli ? { root, install: t.install?.cwd ?? t.cwd, manager: t.tauri.manager, ...t.tauri.cli } : undefined;
    const installedCli = tauriCli && resolveTauriCli(tauriCli);
    const node = tauriCli ? tool.bindings?.node : undefined;
    if (tauriCli && !node) throw new Error("缺少 Tauri CLI 使用的所选 Node");
    const invoke = tauriCli ? [installedCli?.path ?? "<依赖准备后确认项目 Tauri CLI>"] : ["tauri"];
    const scriptBins = tauriCli && tauriScriptBins(root, cwd, tauriCli, tool.executable);
    return { args: [...invoke, "build", ...(selected.debug ? ["--debug"] : []), "--no-bundle", ...selected.args], outputs: t.outputs,
      executable: node, scriptBins, tauriCli: tauriCli && { request: tauriCli, installed: installedCli },
      cargo: rustContext(root, t.project, t.tauri.workspace, tool), environment: bindings, planInputs: inputs };
  }
  if (t.cargo) {
    validateOptions(() => cargoOptions(root, t.cwd, opts));
    const report = !opts.some((s) => /^--message-format(?:=|$)/u.test(s));
    return { args: ["build", ...(t.cargo.name ? ["--package", t.cargo.name] : ["--workspace"]), ...(report ? ["--message-format=json-render-diagnostics"] : []), ...opts],
      outputs: [], cargo: rustContext(root, t.cwd, t.cargo.workspace, tool), cargoReport: report };
  }
  assertJsConfig(root, t, tool, "script");
  // The package script owns its arguments. npm needs a separator; pnpm forwards everything after the script name.
  return { args: ["run", t.name, ...(opts.length && t.adapter === "npm" ? ["--"] : []), ...opts], outputs: t.outputs };
}

export function preparation(root: string, t: ProjectTarget, tool: Tool): { steps: { cwd: string; invocation: Invocation }[]; notice?: string } {
  const manager = t.tauri?.manager ?? t.adapter;
  const install = t.install;
  if (!install || (manager !== "npm" && manager !== "pnpm")) return { steps: [] };
  if (!install.required.length && !install.workspace) return { steps: [], notice: "未声明需安装的依赖" };
  // A package manifest, lock or PnP loader may survive an incomplete install. Let the native manager decide what to reuse.
  assertJsConfig(root, t, tool, "install");
  const args = ["install"];
  return { notice: "安装就绪状态无法从文件确认；由包管理器按项目配置复用或准备依赖。",
    steps: [{ cwd: install.cwd, invocation: { executable: tool.executable, args, cwd: resolveWithin(root, install.cwd), env: tool.env, bindings: tool.bindings } }] };
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

export async function verifyTool(t: ProjectTarget, tool: Tool, owned: Set<OwnedProcess>, accept: () => void, root?: string): Promise<VerifiedTool> {
  if (t.xcode) {
    const common = { cwd: tmpdir(), env: tool.env, executable: tool.executable };
    const version = await checkedCommand({ ...common, args: ["-version"] }, owned, accept);
    const sdk = await checkedCommand({ ...common, args: ["-version", "-sdk", "iphonesimulator", "SDKVersion"] }, owned, accept);
    if (!/^Xcode \d/u.test(version) || !matchesVersion(sdk, undefined)) throw new Error("未确认完整 Xcode 与 iPhone Simulator SDK");
    return { version: [version.split("\n")[0], "iPhone Simulator SDK " + sdk].join(" · ") };
  }
  if (t.gradle) {
    const java = tool.candidate.paths[0];
    if (!java) throw new Error("缺少 Java");
    const output = await checkedCommand({ cwd: tmpdir(), env: { ...tool.env, JAVA_TOOL_OPTIONS: undefined }, executable: java, args: ["-version"] }, owned, accept, true);
    const jv = /(?:openjdk|java) version "([^"+]+)(?:\+[^"\n]*)?"/u.exec(output)?.[1] ?? "";
    const pin = t.requirements.miseJava;
    if (pin && !matchesMiseVersion(/^\d+$/u.test(jv) ? jv + ".0.0" : jv, pin, "java", java, tool.env)) throw new Error(`启动 Java 无法满足 mise 声明 ${pin}；请选择匹配的已安装 JDK`);
    const version = output.split("\n").find((line) => /(?:openjdk|java) version "/u.test(line)) ?? output.split("\n")[0];
    return { version: `启动 Java：${version}` };
  }
  if (t.cmake) {
    const cmake = tool.executable;
    const cv = (await checkedCommand({ cwd: tmpdir(), env: tool.env, executable: cmake, args: ["--version"] }, owned, accept)).split("\n")[0] ?? "";
    const found = /^cmake version (\d+\.\d+\.\d+)/u.exec(cv)?.[1];
    if (!found || !matchesVersion(found, t.cmake.preset ? ">=3.19" : ">=3.14") || !matchesMiseVersion(found, t.requirements.miseCmake, "cmake", cmake, tool.env)) {
      throw new Error("CMake 版本不支持所选配置，或与 mise 声明不符");
    }
    return { version: cv };
  }
  if (t.adapter === "cargo" || t.tauri) {
    const offset = t.tauri?.manager ? 2 : 0;
    const [cargo, rustc] = tool.candidate.paths.slice(offset);
    if (!cargo || !rustc) throw new Error("缺少 Cargo 或 rustc");
    const common = { cwd: tmpdir(), env: tool.env, bindings: tool.bindings, args: ["--version"] };
    const cv = await checkedCommand({ ...common, executable: tool.bindings ? "cargo" : cargo }, owned, accept);
    const rv = await checkedCommand({ ...common, executable: tool.bindings ? "rustc" : rustc }, owned, accept);
    const found = /^rustc (\d+\.\d+\.\d+)/u.exec(rv)?.[1];
    if (!found || !matchesVersion(found, t.requirements.rust && `>=${t.requirements.rust}`)) throw new Error(`Rust 版本不符合要求：${rv.slice(0, 80)}`);
    const rust = `${cv.split(" ").slice(0, 2).join(" ")} · ${rv.split(" ").slice(0, 2).join(" ")}`;
    if (!t.tauri) return { version: rust };
    const js = t.tauri.manager ? await verifyJs(t, tool, owned, accept, t.tauri.manager, root) : undefined;
    const cliVersion = tool.tauriCargoCli && await checkedCommand({ ...common, executable: cargo, args: ["tauri", "--version"] }, owned, accept);
    return { ...js, version: [js?.version, rust, cliVersion || "Tauri CLI 由项目依赖提供", "目标 SDK 由构建检查"].filter(Boolean).join(" · ") };
  }
  if (t.adapter === "npm" || t.adapter === "pnpm") return verifyJs(t, tool, owned, accept, t.adapter, root);
  throw new Error("该目标没有可验证的工具链");
}

async function verifyJs(t: ProjectTarget, tool: Tool, owned: Set<OwnedProcess>, accept: () => void, managerName: string, root?: string): Promise<VerifiedTool> {
  const [node, manager] = tool.candidate.paths;
  if (!node || !manager || [node, manager].some(autoInstallRisk)) throw new Error("请选择已安装的 Node 和包管理器。");
  const common = { cwd: tmpdir(), env: tool.env, bindings: tool.bindings, args: ["--version"] };
  const scope = (selected: Tool) => {
    if (!root) return;
    assertJsConfig(root, t, selected, "script");
    if (t.install && (t.install.workspace || t.install.required.length)) assertJsConfig(root, t, selected, "install");
  };
  scope(tool);
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
  const matches = (req: ProjectTarget["requirements"]) => matchesVersion(nv, req.node) && matchesMiseVersion(nv, req.miseNode, "node", node, tool.env) &&
    matchesVersion(mv, req.manager) && matchesMiseVersion(mv, req.miseManager, managerName, manager, tool.env) && matchesVersion(mv, req.managerEngine);
  if (!matches(t.requirements)) {
    throw new Error(`版本不符合要求或声明无法验证：Node ${nv.slice(0, 60)} · ${managerName} ${mv.slice(0, 60)}；需要 ${requirement(t)}`);
  }
  const install = t.requirements.install;
  if (install && !matches(install)) {
    throw new Error(`版本不满足依赖安装根 ${t.install?.cwd} 的 Node 或 ${managerName} 声明`);
  }
  const version = `Node ${nv} · ${managerName} ${mv}`;
  if (managerName !== "pnpm") return { version };
  const pnpmMajor = Number(mv.replace(/^v/u, "").split(".")[0]);
  scope({ ...tool, pnpmMajor });
  return { version: version + "（脚本使用绑定的 Node）", pnpmMajor };
}
