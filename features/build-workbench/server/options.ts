import { isAbsolute } from "node:path";
import { resolveWithin } from "./paths";

type Check = (value: string) => boolean;
type Rule = true | Check | { optional: Check };
const value = (s: string) => !!s && !s.startsWith("-");
const integer = (s: string) => /^[1-9]\d*$/u.test(s);
const identifier = (s: string) => /^[\w][\w.+-]{0,79}$/u.test(s);
const mode = (s: string) => /^[\w][\w .+-]{0,79}$/u.test(s);
const flags = (...names: string[]): Record<string, Rule> => Object.fromEntries(names.map((name) => [name, true]));

function parse(args: string[], rules: Record<string, Rule>, extra?: (arg: string) => boolean) {
  const applied = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (extra?.(arg)) continue;
    const split = arg.indexOf("=");
    const name = split < 0 ? arg : arg.slice(0, split);
    const rule = Object.hasOwn(rules, name) ? rules[name] : undefined;
    if (!rule) throw new Error(`此工具或操作不支持选项 ${name || "（空）"}`);
    if (rule === true) {
      if (split !== -1) throw new Error(`${name} 不接受值`);
      applied.set(name, "");
    } else {
      const check = typeof rule === "function" ? rule : rule.optional;
      const val = split < 0 ? args[i + 1] : arg.slice(split + 1);
      if (val !== undefined && check(val)) {
        if (split < 0) i++;
        applied.set(name, val);
      } else if (split < 0 && typeof rule === "object") applied.set(name, "");
      else throw new Error(`${name} 缺少有效的参数值`);
    }
  }
  return applied;
}

export function cargoOptions(root: string, cwd: string, args: string[]) {
  const selected = parse(args, {
    ...flags("--release", "--locked", "--offline", "--frozen", "--keep-going", "--all-features", "--no-default-features",
      "--bins", "--examples", "--tests", "--benches", "--lib", "--all-targets", "-v", "-vv", "--verbose", "-q", "--quiet"),
    "--profile": identifier, "--target": (s) => {
      if (identifier(s) && !s.endsWith(".json")) return true;
      if (!s.endsWith(".json") || isAbsolute(s)) return false;
      try { resolveWithin(root, cwd === "." ? s : cwd + "/" + s); return true; }
      catch { return false; }
    },
    "--features": value, "-F": value, "--jobs": integer, "-j": integer,
    "--bin": identifier, "--example": identifier, "--test": identifier, "--bench": identifier, "--message-format": value,
  });
  if (selected.has("--release") && selected.has("--profile")) throw new Error("--release 和 --profile 只能选择一个");
  const profile = selected.get("--profile") ?? (selected.has("--release") ? "release" : "dev");
  const targets = args.flatMap((arg, i) => arg === "--target" ? [args[i + 1]!] : arg.startsWith("--target=") ? [arg.slice(9)] : []);
  return { profile: profile === "dev" || profile === "test" ? "debug" : profile === "bench" ? "release" : profile, targets };
}

export function gradleOptions(args: string[], probe: boolean) {
  const reserved = /^(?:org\.gradle\.(?:daemon|native)(?:\.|$)|org\.gradle\.java\.home$)/u;
  const flagsByPhase: Record<string, Rule> = probe ? {} : { "--tests": value, "--args": value, "--rerun": true };
  parse(args, {
    ...flags("--offline", "--refresh-dependencies", "--parallel", "--no-parallel", "--build-cache", "--no-build-cache",
      "--configuration-cache", "--no-configuration-cache", "--configure-on-demand", "--continue", "--rerun-tasks",
      "--stacktrace", "--full-stacktrace", "--info", "--debug", "--warn", "--quiet", "-s", "-i", "-q"),
    "--warning-mode": identifier, "--max-workers": integer,
    "--exclude-task": (s) => /^:?[\w][\w.:-]*$/u.test(s), "-x": (s) => /^:?[\w][\w.:-]*$/u.test(s), ...flagsByPhase,
  }, (arg) => {
    const name = /^-[PD]([\w][\w.-]*)(?:=.*)?$/u.exec(arg)?.[1];
    return !!name && !reserved.test(name);
  });
}

export function cmakeOptions(args: string[], probe: boolean) {
  if (!probe) return parse(args, { ...flags("--verbose", "-v"), "--parallel": { optional: integer }, "-j": { optional: integer }, "--config": identifier }).get("--config");
  const cacheEntry = (s: string) => /^[\w][\w.-]*(?::\w+)?=.*$/u.test(s);
  parse(args, { ...flags("--fresh", "--debug-output", "--log-context", "-Wdev", "-Wno-dev", "--warn-uninitialized"), "-G": value, "-A": value, "-T": value, "-D": cacheEntry, "--log-level": identifier,
  }, (arg) => arg.startsWith("-D") && cacheEntry(arg.slice(2)));
}

export function xcodeOptions(args: string[], probe: boolean) {
  if (probe) return parse(args, flags("-quiet", "-verbose"));
  return parse(args, { ...flags("-parallelizeTargets", "-showBuildTimingSummary", "-quiet", "-verbose"), "-configuration": mode, "-arch": identifier, "-jobs": integer }, (arg) => {
    const setting = /^([A-Z_][A-Z_0-9]*)=.*$/u.exec(arg)?.[1];
    return !!setting && !/^(?:CODE_SIGN|EXPANDED_CODE_SIGN|PROVISIONING|DEVELOPMENT_TEAM$|SDKROOT$|CONFIGURATION$|ACTION$|PLATFORM_NAME$|SYMROOT$|OBJROOT$|BUILD_DIR$|TARGET_BUILD_DIR$)/u.test(setting);
  });
}

export function tauriOptions(root: string, cwd: string, args: string[]) {
  const configPath = (s: string) => {
    if (!value(s) || !/\.(?:json5?|toml)$/iu.test(s) || isAbsolute(s)) return false;
    try { resolveWithin(root, cwd === "." ? s : cwd + "/" + s); return true; }
    catch { return false; }
  };
  const separator = args.indexOf("--");
  const cli = separator >= 0 ? args.slice(0, separator) : args;
  const cargo = separator >= 0 ? args.slice(separator + 1) : [];
  const selected = parse(cli, { ...flags("--release", "--debug", "--no-bundle", "--ci", "-v", "--verbose"), "--features": value, "--target": identifier, "--config": configPath });
  if (selected.has("--debug") && selected.has("--release")) throw new Error("Tauri 的 Debug 和 Release 只能选择一个");
  parse(cargo, { ...flags("--locked", "--offline", "--frozen", "--no-default-features", "--all-features"), "--jobs": integer, "-j": integer });
  return { debug: !selected.has("--release"), target: selected.get("--target"), args: [
    ...cli.filter((arg) => !["--release", "--debug", "--no-bundle"].includes(arg)), ...(cargo.length ? ["--", ...cargo] : []),
  ] };
}
