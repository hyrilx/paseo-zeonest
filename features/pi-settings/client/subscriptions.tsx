import { useEffect, useRef, useState } from "react";
import { Modal, ScrollView, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Linking, View } from "react-native";
import type { CatalogModel, SubscriptionAuthState, SubscriptionCatalog } from "../shared/contracts";
import { isObject, type JsonObject } from "../shared/config";
import { subscriptionScope } from "../shared/management";
import { Button } from "./components";
import { ModelAdvanced } from "./entity";
import { Caption, Field, Heading, ListRow, matches, row, type Theme } from "./layout";

type Reply = { action: "status" | "cancel" | "reply"; id?: number; value?: string };
type AuthAction = "login" | "logout";
interface Props {
  theme: Theme; catalog: SubscriptionCatalog | null; document: JsonObject; patterns: string[];
  blocked: boolean; project: boolean; canRead: boolean; canScope: boolean; canOverride: boolean;
  load(provider?: string): void; begin(provider: string, action: AuthAction): Promise<string>;
  interact(token: string, request: Reply): Promise<SubscriptionAuthState>; complete(provider: string): void; setAuthBusy(value: boolean): void;
  toggle(ref: string, enabled: boolean): void; makeDefault(model: CatalogModel): void;
  changeOverride(model: CatalogModel, key: string, value: unknown): void;
}
export function Subscriptions({ theme, catalog, document, patterns, blocked, project, canRead, canScope, canOverride, load, begin, interact, complete, setAuthBusy, toggle, makeDefault, changeOverride }: Props) {
  const [providerId, setProvider] = useState(""); const [query, setQuery] = useState(""); const [ref, setRef] = useState("");
  const [auth, setAuth] = useState<{ provider: string; action: AuthAction; token?: string; state?: SubscriptionAuthState }>();
  const [reply, setReply] = useState(""); const [error, setError] = useState(""); const [sending, setSending] = useState(false);
  const generation = useRef(0); const currentToken = useRef<string | undefined>(undefined); const busy = useRef(false);
  const actions = useRef({ interact, complete }); actions.current = { interact, complete };
  const provider = catalog?.providers.find(({ id }) => id === providerId) ?? catalog?.providers.find(({ connected }) => connected) ?? catalog?.providers[0];
  const available = catalog?.models.filter((item) => item.provider === provider?.id) ?? [];
  const selected = available.find((item) => `${item.provider}/${item.id}` === ref);
  const scope = catalog && subscriptionScope(catalog, patterns);
  const providerConfig = isObject(document.providers) && provider ? document.providers[provider.id] : undefined;
  const overrides = isObject(providerConfig) && isObject(providerConfig.modelOverrides) ? providerConfig.modelOverrides : {};
  const modelConfig = selected ? overrides[selected.id] : undefined;
  const override = isObject(modelConfig) ? modelConfig : {};
  const message = (e: unknown) => e instanceof Error ? e.message : "订阅操作失败。";
  function release() {
    generation.current++;
    const token = currentToken.current; currentToken.current = undefined;
    if (token) void actions.current.interact(token, { action: "cancel" }).catch(() => {});
  }
  useEffect(() => () => release(), []);
  const modalOpen = !!auth;
  useEffect(() => { setAuthBusy(modalOpen); return () => setAuthBusy(false); }, [modalOpen, setAuthBusy]);
  async function start(id: string, action: AuthAction) {
    const run = ++generation.current;
    setError(""); setReply(""); setAuth({ provider: id, action });
    try {
      const token = await begin(id, action);
      if (run !== generation.current) { void actions.current.interact(token, { action: "cancel" }).catch(() => {}); return; }
      currentToken.current = token;
      setAuth({ provider: id, token, action, state: { status: "pending" } });
    } catch (e) { if (run === generation.current) { setError(message(e)); setAuth(undefined); } }
  }
  const token = auth?.token;
  const running = auth?.state?.status === "pending";
  useEffect(() => {
    if (!token || !running) return;
    const run = generation.current;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!token || !active || run !== generation.current) return;
      try {
        if (!busy.current) {
          const state = await actions.current.interact(token, { action: "status" });
          if (!active || run !== generation.current) return;
          setAuth((previous) => previous?.token === token ? { ...previous, state } : previous);
          if (state.status !== "pending") {
            currentToken.current = undefined;
            if (state.status === "success" && auth) { setAuth(undefined); actions.current.complete(auth.provider); }
            return;
          }
        }
        timer = setTimeout(() => { void poll(); }, 900);
      } catch (e) { if (active && run === generation.current) { release(); setAuth(undefined); setError(message(e)); } }
    }
    timer = setTimeout(() => { void poll(); }, 100);
    return () => { active = false; clearTimeout(timer); };
  }, [token, running]);
  const prompt = auth?.state?.prompt;
  useEffect(() => { setReply(""); }, [prompt?.id]);
  async function send() {
    if (!token || !prompt || !reply.trim() || busy.current) return;
    busy.current = true; setSending(true); setError("");
    const run = generation.current;
    try { await interact(token, { action: "reply", id: prompt.id, value: reply }); if (run === generation.current) setReply(""); }
    catch (e) { if (run === generation.current) setError(message(e)); }
    finally { busy.current = false; if (run === generation.current) setSending(false); }
  }
  function close() { release(); setSending(false); setAuth(undefined); setReply(""); setError(""); }

  return <>
    <Heading title="订阅模型" theme={theme} action={<Button label={catalog ? "重新读取" : "读取订阅目录"} theme={theme} disabled={!canRead} onPress={() => load()} />} />
    {!catalog && <Caption theme={theme}>读取宿主 Pi 的目录和连接状态后，即可管理订阅和模型。</Caption>}
    {catalog && !provider && <Caption theme={theme}>当前 Pi 没有可管理的订阅供应商。</Caption>}
    {provider && <>
      <SettingsSelect label="订阅供应商" value={provider.id} options={catalog!.providers.map(({ id, name, connected }) => ({ value: id, label: `${name} · ${connected ? "已连接" : "未登录"}` }))} onValueChange={(id) => { setProvider(id); setQuery(""); setRef(""); }} disabled={blocked} />
      <View style={row}>
        <Button label="刷新模型目录" theme={theme} disabled={!canRead || !provider.connected} onPress={() => load(provider.id)} />
        <Button label={provider.connected ? "退出订阅" : "登录订阅"} theme={theme} disabled={!canRead || project || !!auth} onPress={() => {
          setError("");
          if (provider.connected) setAuth({ provider: provider.id, action: "logout" });
          else void start(provider.id, "login");
        }} />
      </View>
      {project && <Caption theme={theme}>项目可改模型范围；订阅登录和上下文覆盖在全局范围管理。</Caption>}
      {catalog?.refreshFailed && <Caption theme={theme}>远端刷新未完成，当前显示 Pi 的本地目录。</Caption>}
      {available.length > 0 && <>
        <Field label="搜索订阅模型" placeholder="搜索模型 ID" search value={query} theme={theme} onChangeText={setQuery} />
        {selected && <View key={ref} style={{ gap: 7, padding: 8, backgroundColor: theme.colors.surface1, borderRadius: 5 }}>
          <Heading theme={theme} title={selected.id} detail={`目录上下文 ${selected.contextWindow.toLocaleString()} · 最大输出 ${selected.maxOutput}`} />
          <SettingsSwitch label="在模型范围内启用" value={scope?.active.has(ref) ?? false} disabled={!canScope || !scope} onValueChange={(enabled) => toggle(ref, enabled)} />
          {!scope && <Caption theme={theme}>匹配规则尚未解析。保存或重新读取目录后可切换。</Caption>}
          <Field label="上下文窗口（tokens）" value={typeof override.contextWindow === "number" ? String(override.contextWindow) : ""} placeholder={String(selected.contextWindow)} theme={theme} disabled={!canOverride} onChangeText={(text) => {
            if (!/^(?:\d{0,10})$/.test(text)) return;
            changeOverride(selected, "contextWindow", text ? Number(text) : undefined);
          }} action={<Button label="恢复默认上下文" theme={theme} disabled={!canOverride || override.contextWindow === undefined} onPress={() => changeOverride(selected, "contextWindow", undefined)} />} />
          <ModelAdvanced key={ref} model={override} theme={theme} disabled={!canOverride} change={(key, value) => changeOverride(selected, key, value)}
            action={<Button label="设为默认" theme={theme} disabled={!canScope} onPress={() => makeDefault(selected)} />} />
        </View>}
        <ScrollView nestedScrollEnabled style={{ maxHeight: 290, flexGrow: 0 }} keyboardShouldPersistTaps="handled">
          {available.filter((model) => matches(query, model.id)).map((model) => {
            const key = `${model.provider}/${model.id}`;
            return <ListRow key={key} theme={theme} label={model.id} detail={`${model.contextWindow.toLocaleString()} 上下文`} badge={scope ? scope.active.has(key) ? "启用" : "停用" : undefined} active={ref === key} onPress={() => setRef(key)} />;
          })}
        </ScrollView>
      </>}
      {!available.length && <Caption theme={theme}>{provider.connected ? "目录没有可用模型。可以刷新远端目录。" : "连接订阅后即可读取可用模型。"}</Caption>}
    </>}
    {error && !auth && <Caption theme={theme}>{error}</Caption>}
    <Modal open={!!auth} title={auth?.action === "logout" ? "退出订阅" : "连接订阅"} onOpenChange={(open) => { if (!open) close(); }}><Modal.Content>
      {auth?.action === "logout" && !auth.token && <>
        <Caption theme={theme}>删除 Pi 保存的 {auth.provider} OAuth 登录。其他供应商和模型配置不受影响。</Caption>
        <View style={row}><Button label="取消" theme={theme} onPress={close} /><Button label="确认退出" theme={theme} disabled={sending} onPress={() => { setSending(true); void start(auth.provider, "logout").finally(() => setSending(false)); }} /></View>
      </>}
      {auth?.action === "login" && !auth.token && <Caption theme={theme}>正在启动 Pi 登录…</Caption>}
      {auth?.state?.status === "pending" && <>
        <Caption theme={theme}>{auth.state.url ? "在浏览器中完成授权，随后返回此页。" : "等待 Pi 提供下一步…"}</Caption>
        {auth.state.url && <Button label="打开授权页面" theme={theme} onPress={() => { const url = auth.state?.url; if (url) void Linking.openURL(url).catch((e: unknown) => setError(message(e))); }} />}
        {auth.state.code && <Caption theme={theme} selectable>设备代码：{auth.state.code}</Caption>}
        {prompt?.kind === "select" && <SettingsSelect label={prompt.message || "登录方式"} value={reply} options={[{ value: "", label: "请选择" }, ...(prompt.options ?? [])]} onValueChange={setReply} disabled={sending} />}
        {prompt && prompt.kind !== "select" && <Field theme={theme} label={prompt.message || "授权码"} value={reply} secret={prompt.kind !== "text"} disabled={sending} onChangeText={setReply} />}
        {prompt && <Button label="提交给 Pi" theme={theme} disabled={!reply.trim() || sending} onPress={() => { void send(); }} />}
      </>}
      {error && <Caption theme={theme}>{error}</Caption>}
      {auth?.state?.status === "failed" && <Caption theme={theme}>Pi 未完成订阅操作。可重试，或在宿主使用 pi auth。</Caption>}
      {auth && (auth.action === "login" || auth.token) && <Button label={auth.state?.status === "failed" ? "关闭" : "取消订阅操作"} theme={theme} onPress={close} />}
    </Modal.Content></Modal>
  </>;
}
