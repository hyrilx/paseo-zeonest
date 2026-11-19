import { Fragment, useState } from "react";
import { ScrollView, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { CatalogModel } from "../shared/contracts";
import { isObject, setProperty, stringList, type JsonObject } from "../shared/config";
import { customModels } from "../shared/management";
import { Button } from "./components";
import { Caption, Field, Heading, ListRow, matches, row, type Theme } from "./layout";

export function modelCatalog(document: JsonObject, inventory: CatalogModel[]) {
  return [...new Map([...customModels(document), ...inventory].map((model) => [`${model.provider}/${model.id}`, model])).values()];
}
export function ModelDefaults({ theme, project, disabled, settings, global, update, editSource }: {
  theme: Theme; project: boolean; disabled: boolean; settings: JsonObject; global: JsonObject;
  update(key: string, value: unknown): void; editSource: React.ReactNode;
}) {
  const [patterns, setPatterns] = useState(false);
  const [patternInput, setPatternInput] = useState(() => stringList(settings.enabledModels).join(", "));
  const effective = (key: string) => (project ? global[key] : undefined);
  const value = (key: string) => typeof settings[key] === "string" ? String(settings[key]) : "";
  const current = settings.enabledModels;
  const inherited = effective("enabledModels");
  const mode = current === undefined ? "inherit" : stringList(current).length === 0 ? "all" : "selected";
  return <>
    <Heading title="默认值与模型范围" theme={theme} detail={project ? "项目未设置的字段继承全局。" : undefined} />
    <View style={row}>
      <View style={{ flex: 1, minWidth: 180 }}><Field label="默认供应商" theme={theme} value={value("defaultProvider")} placeholder={typeof effective("defaultProvider") === "string" ? `继承 ${effective("defaultProvider")}` : "由 Pi 选择"} disabled={disabled} onChangeText={(next) => update("defaultProvider", next || undefined)} /></View>
      <View style={{ flex: 1, minWidth: 180 }}><Field label="默认模型 ID" theme={theme} value={value("defaultModel")} placeholder={typeof effective("defaultModel") === "string" ? `继承 ${effective("defaultModel")}` : "由 Pi 选择"} disabled={disabled} onChangeText={(next) => update("defaultModel", next || undefined)} /></View>
    </View>
    <SettingsSelect label="默认思考等级" value={value("defaultThinkingLevel") || "inherit"} options={[{ label: project ? `继承全局（${String(global.defaultThinkingLevel ?? "Pi 默认")}）` : "使用 Pi 默认值", value: "inherit" }, ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ label: value, value }))]} disabled={disabled} onValueChange={(value) => update("defaultThinkingLevel", value === "inherit" ? undefined : value)} />
    <View style={{ gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <Caption theme={theme}>{mode === "selected" ? `已配置 ${stringList(current).length} 条选择规则` : mode === "inherit" && project && stringList(inherited).length ? `继承全局 · ${stringList(inherited).length} 条规则` : "全部可用模型"}。在「可用模型」中选择具体模型。</Caption>
      <View style={row}>
        {project && <Button label="继承全局范围" theme={theme} disabled={disabled || mode === "inherit"} onPress={() => update("enabledModels", undefined)} />}
        <Button label="使用全部可用模型" theme={theme} disabled={disabled || mode === "all" || (!project && mode === "inherit")} onPress={() => update("enabledModels", project ? [] : undefined)} />
        <Button label={patterns ? "收起匹配规则" : "编辑匹配规则"} theme={theme} onPress={() => { if (!patterns) setPatternInput(stringList(current).join(", ")); setPatterns(!patterns); }} />
      </View>
      {patterns && <Field label="启用模型范围" theme={theme} value={patternInput} placeholder="provider/model, provider/*, model:high" disabled={disabled} onChangeText={(next) => { setPatternInput(next); update("enabledModels", next.trim() ? next.split(",").map((x) => x.trim()).filter(Boolean) : undefined); }} />}
    </View>
    {editSource}
  </>;
}

export function ModelsInventory({ theme, inventory, probeCatalog, project, settings, global, disabled, canProbe, reload, test, changeSettings }: {
  theme: Theme; inventory: CatalogModel[]; probeCatalog: CatalogModel[] | null; project: boolean; settings: JsonObject; global: JsonObject; disabled: boolean; canProbe: boolean;
  reload(): void; test(model: CatalogModel): void; changeSettings(update: (text: string) => string): void;
}) {
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState<string>();
  const explicit = settings.enabledModels !== undefined;
  const rules = stringList(explicit ? settings.enabledModels : project ? global.enabledModels : undefined);
  const provider = settings.defaultProvider ?? (project ? global.defaultProvider : undefined);
  const defaultModel = settings.defaultModel ?? (project ? global.defaultModel : undefined);
  const visible = inventory.filter((model) => matches(query, model.provider, model.id));
  const groups = new Map<string, CatalogModel[]>();
  for (const model of visible) {
    const group = groups.get(model.provider);
    if (group) group.push(model); else groups.set(model.provider, [model]);
  }
  const active = visible.find((model) => `${model.provider}/${model.id}` === selected);
  const toggle = (model: CatalogModel) => {
    const name = `${model.provider}/${model.id}`;
    const next = rules.includes(name) ? rules.filter((rule) => rule !== name) : [...rules, name];
    changeSettings((text) => setProperty(text, ["enabledModels"], next));
  };
  return <>
    <Heading title="可用模型" theme={theme} detail={`${inventory.length} 个模型 · ${probeCatalog ? "Pi 目录和自定义配置" : "当前仅显示自定义配置"}`} action={<Button label={probeCatalog ? "刷新 Pi 目录" : "读取 Pi 目录"} theme={theme} disabled={!canProbe} onPress={reload} />} />
    <Field label="搜索模型" placeholder="按供应商或模型 ID 搜索" search theme={theme} value={query} onChangeText={setQuery} />
    <Caption theme={theme}>{rules.length ? `${explicit ? "本范围" : "全局"}已配置 ${rules.length} 条规则。星号、模糊匹配与思考等级规则由 Pi 解析。` : "当前不限模型。在详情中添加第一条精确规则后，循环选模将按规则筛选。"}</Caption>
    {!visible.length && <Caption theme={theme}>{query ? "没有匹配的模型。" : "没有可列出的模型。先读取 Pi 目录，或添加自定义供应商。"}</Caption>}
    {active && <View style={{ padding: 10, gap: 8, backgroundColor: theme.colors.surface1, borderRadius: 5 }}>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{active.provider}/{active.id}</Text>
      <Caption theme={theme}>{[active.context && `上下文 ${active.context}`, active.maxOutput && `输出 ${active.maxOutput}`, active.reasoning && "思考", active.images && "图片"].filter(Boolean).join(" · ")}</Caption>
      <View style={row}>
        <Button label="设为默认" theme={theme} disabled={disabled || (settings.defaultProvider === active.provider && settings.defaultModel === active.id)} onPress={() => changeSettings((text) => setProperty(setProperty(text, ["defaultProvider"], active.provider), ["defaultModel"], active.id))} />
        <Button label={rules.includes(selected!) ? "移除精确规则" : "添加精确规则"} theme={theme} disabled={disabled} onPress={() => toggle(active)} />
        <Button label="测试模型" theme={theme} disabled={!canProbe || !probeCatalog?.some((model) => model.provider === active.provider && model.id === active.id)} onPress={() => test(active)} />
      </View>
    </View>}
    {visible.length > 0 && <ScrollView nestedScrollEnabled style={{ maxHeight: 390, flexGrow: 0 }} contentContainerStyle={{ gap: 2 }} keyboardShouldPersistTaps="handled">
      {Array.from(groups, ([name, models]) => <Fragment key={name}>
        <Caption theme={theme}>{name} · {models.length}</Caption>
        {models.map((model) => {
          const name = `${model.provider}/${model.id}`;
          const badge = [provider === model.provider && defaultModel === model.id ? "默认" : "", rules.includes(name) ? "精确" : ""].filter(Boolean).join(" · ") || undefined;
          return <ListRow key={name} label={model.id} badge={badge} active={name === selected} theme={theme} onPress={() => setSelected(name)} />;
        })}
      </Fragment>)}
    </ScrollView>}
  </>;
}

export const providerEntries = (document: JsonObject) => Object.entries(isObject(document.providers) ? document.providers : {});
