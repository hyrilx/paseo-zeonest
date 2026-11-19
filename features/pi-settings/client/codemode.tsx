import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { isObject, stringList, type JsonObject } from "../shared/config";
import { codemodeToolRules, resolveCodemode } from "../shared/management";
import { Caption, Field, Heading, type Theme } from "./layout";

type Set = (path: string[], value: unknown) => void;
const inherited = (value: unknown) => Array.isArray(value) ? stringList(value) : undefined;
const autoLabel = (value: boolean) => value ? "自动启用" : "不自动启用";

export function McpCodeMode({ theme, project, settings, global, mcp, globalMcp, settingsLocked, mcpLocked, changeSettings, changeMcp }: {
  theme: Theme; project: boolean; settings: JsonObject; global: JsonObject; mcp: JsonObject; globalMcp: JsonObject;
  settingsLocked: boolean; mcpLocked: boolean; changeSettings: Set; changeMcp: Set;
}) {
  const globalRules = project ? inherited(global.defaultTools) : inherited(settings.defaultTools);
  const projectRules = project ? inherited(settings.defaultTools) : undefined;
  const always = resolveCodemode(globalRules, projectRules);
  const cfg = isObject(settings.codemode) ? settings.codemode : {};
  const fromGlobal = project && isObject(global.codemode) ? global.codemode : {};
  const auto = mcp.autoEnableCodemode;
  const fallback = !project || globalMcp.autoEnableCodemode !== false;
  const localMode = typeof cfg.mode === "string" ? cfg.mode : "";
  const fallbackMode = fromGlobal.mode === "only" ? "仅代码模式" : "允许常规工具";
  const extensionRules = [...(project ? stringList(global.extensions) : []), ...stringList(settings.extensions)];
  const builtinOff = extensionRules.findLast((rule) => rule === "+builtin:codemode" || rule === "-builtin:codemode") === "-builtin:codemode";
  return <>
    <Heading title="代码模式" theme={theme} detail={project ? "项目信任后，Pi 才会加载项目配置。" : "控制 Pi 如何通过代码模式使用 MCP 工具。"} />
    <SettingsSelect label="启动策略" value={always ? "always" : "automatic"} disabled={settingsLocked || project}
      options={[{ label: "按需启用", value: "automatic" }, { label: "启动时启用", value: "always" }]}
      onValueChange={(next) => changeSettings(["defaultTools"], codemodeToolRules(globalRules, next === "always"))} />
    {project && <Caption theme={theme}>此处显示项目规则合并后的启动策略；请在全局范围修改默认策略。</Caption>}
    <SettingsSelect label="工具模式" value={localMode} disabled={settingsLocked} options={[
      { label: project ? `继承全局（${fallbackMode}）` : "Pi 默认（允许常规工具）", value: "" },
      { label: "允许常规工具", value: "on" }, { label: "仅代码模式", value: "only" },
    ]} onValueChange={(value) => changeSettings(["codemode", "mode"], value || undefined)} />
    <Field label="内联工具声明预算（token）" value={typeof cfg.inlineBudget === "number" ? String(cfg.inlineBudget) : ""}
      placeholder={String(typeof fromGlobal.inlineBudget === "number" ? fromGlobal.inlineBudget : 3000)} theme={theme} disabled={settingsLocked}
      onChangeText={(value) => { if (/^\d*$/.test(value) && Number.isSafeInteger(Number(value))) changeSettings(["codemode", "inlineBudget"], value ? Number(value) : undefined); }} />
    <Caption theme={theme}>超出预算的工具声明按需加载；留空使用继承值。</Caption>
    <SettingsSelect label="MCP 按需启用" disabled={mcpLocked} value={typeof auto === "boolean" ? String(auto) : ""} options={[
      { label: `${project ? "继承全局" : "Pi 默认"}（${autoLabel(fallback)}）`, value: "" },
      { label: "自动启用", value: "true" }, { label: "不自动启用", value: "false" },
    ]} onValueChange={(value) => changeMcp(["autoEnableCodemode"], value ? value === "true" : undefined)} />
    {builtinOff ? <Caption theme={theme}>内置 codemode 扩展已停用，请先在「插件 → Pi 内置扩展」启用它。</Caption> : null}
    <Caption theme={theme}>沙箱状态：此页未检测。实际可用性由宿主 Pi 决定。</Caption>
  </>;
}
