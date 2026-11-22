import type { Target } from "../shared/contracts";

type Option = readonly [flag: string, description: string];
const gradle = [
  ["--offline", "仅使用本地缓存，不下载依赖"],
  ["--stacktrace", "出错时显示堆栈"],
  ["--info", "显示更多运行信息"],
] satisfies Option[];
const scripts = [["--mode staging", "传给项目脚本；脚本需支持此选项"]] satisfies Option[];

export function commonOptions({ adapter, operation }: Pick<Target, "adapter" | "operation">): readonly Option[] {
  switch (adapter) {
    case "cmake": return operation ? [
      ["-DCMAKE_BUILD_TYPE=Release", "采用 Release 构建类型"],
      ["-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "生成 compile_commands.json（Makefile 或 Ninja）"],
    ] : [
      ["--parallel 4", "最多并行执行 4 个构建任务"],
      ["--verbose", "显示实际执行的构建命令"],
    ];
    case "cargo": return [
      ["--release", "使用 release 配置构建"],
      ["--locked", "要求 Cargo.lock 保持不变"],
      ["--offline", "离线构建"],
    ];
    case "gradle": return gradle;
    case "npm":
    case "pnpm": return scripts;
    case "tauri": return [
      ["--debug", "使用调试配置构建"],
      ["--verbose", "显示详细构建信息"],
    ];
    case "xcode": return operation ? [
      ["-verbose", "显示详细探测信息"],
    ] : [
      ["-configuration Release", "使用 Release 配置构建"],
      ["-showBuildTimingSummary", "显示构建用时摘要"],
    ];
  }
}

export function appendOptions(draft: string, flags: readonly string[]) {
  return flags.length ? draft + (draft && !/\s$/u.test(draft) ? " " : "") + flags.join(" ") : draft;
}
