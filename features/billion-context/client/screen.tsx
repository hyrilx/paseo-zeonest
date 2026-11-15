import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { ExternalLink, ScrollView, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SidebarRow } from "@getpaseo/plugin/client/ui";
import { errorMessage, listDashboardWorkspaces, resolveDashboard, screenId } from "../shared/contracts";

export function DashboardSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="ChartPie" label="Billion Context" active={currentScreen?.screenId === screenId}
    onPress={() => openScreen({ screenId })} />;
}
export function DashboardScreen(props: PluginScreenProps) {
  // Host and route changes discard all previous host/session URLs and in-flight results.
  return <DashboardPage key={JSON.stringify([props.host.id, props.params.workspaceId, props.params.agentId])} {...props} />;
}
function DashboardPage({ theme, layout, host, params, navigation }: PluginScreenProps) {
  const list = useRpc(listDashboardWorkspaces);
  const resolve = useRpc(resolveDashboard);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [workspaceId, setWorkspaceId] = useState(params.workspaceId ?? "");
  const [target, setTarget] = useState<{ url: string; workspaceId: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const lock = useRef(false);
  const generation = useRef(0);
  const openBrowser = useRef(navigation?.openBrowser);
  openBrowser.current = navigation?.openBrowser;
  const hint = { color: theme.colors.foregroundMuted, lineHeight: 20 };
  function openDesktop(value: { url: string; workspaceId: string }) {
    if (!openBrowser.current) return;
    openBrowser.current({ ...value, serverId: host.id });
    setMessage("已在工作区浏览器打开。");
  }
  async function loadTarget(id: string, autoOpen: boolean) {
    if (lock.current) return;
    const request = ++generation.current;
    lock.current = true; setBusy(true); setError(""); setTarget(null); setMessage("");
    try {
      const value = await resolve({ workspaceId: id, ...(params.agentId ? { agentId: params.agentId } : {}) });
      if (!mounted.current || generation.current !== request) return;
      setTarget(value);
      if (autoOpen) openDesktop(value);
    } catch (failure) {
      if (mounted.current && generation.current === request) setError(errorMessage(failure));
    } finally {
      if (generation.current === request) {
        lock.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    setBusy(true); setError("");
    let cancelled = false;
    if (params.agentId) {
      if (!params.workspaceId) { setError("缺少会话工作区，请从聊天框重新打开详情"); setBusy(false); }
      else void loadTarget(params.workspaceId, true);
    } else {
      void list({}).then((values) => {
        if (cancelled) return;
        setWorkspaces(values);
        setWorkspaceId((previous) => values.some((entry) => entry.id === previous) ? previous : values[0]?.id ?? "");
        setBusy(false);
      }, (failure: unknown) => { if (!cancelled) { setError(errorMessage(failure)); setBusy(false); } });
    }
    return () => { cancelled = true; mounted.current = false; generation.current++; lock.current = false; };
  }, [reload]);
  async function openOverview() {
    await loadTarget(workspaceId, true);
  }
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ fontSize: 22, fontWeight: "600", color: theme.colors.foreground }}>Billion Context · {params.agentId ? "会话详情" : "总览"}</Text>
    <Text style={hint}>{navigation?.openBrowser ? "在当前宿主的工作区浏览器中查看 dashboard。" : "此客户端没有工作区浏览器，请通过下方链接在外部浏览器查看。"}</Text>
    {!params.agentId && <SettingsSection title="目标工作区"><SettingsCard>
      {workspaces.length ? <SettingsSelect label="工作区" value={workspaceId} options={workspaces.map((entry) => ({ label: entry.name, value: entry.id }))}
        disabled={busy} onValueChange={(id) => { generation.current++; setWorkspaceId(id); setTarget(null); setMessage(""); setError(""); }} />
        : <SettingsRow label={busy ? "正在读取工作区…" : "暂无可用工作区"} hint="请先在此宿主创建工作区；本功能不会创建或更改工作区。" />}
      <SettingsAction label="查看 dashboard 总览" actionLabel={busy ? "读取中…" : "打开总览"} disabled={busy || !workspaceId}
        onPress={() => { void openOverview(); }} />
      <SettingsAction label="重新读取工作区" actionLabel="重新读取" disabled={busy}
        onPress={() => { setTarget(null); setMessage(""); setReload((value) => value + 1); }} />
    </SettingsCard></SettingsSection>}
    {params.agentId && <SettingsCard><SettingsAction label="重新定位当前会话" actionLabel={busy ? "读取中…" : "重试"}
      disabled={busy || !workspaceId} onPress={() => { void loadTarget(workspaceId, true); }} /></SettingsCard>}
    {target && <SettingsSection title="Dashboard"><SettingsCard>
      <SettingsRow label={params.agentId ? "已精确定位当前会话" : "Dashboard 总览"} hint={target.url} />
      {navigation?.openBrowser && <SettingsAction label="在工作区浏览器重新打开" actionLabel="打开" onPress={() => {
        try { openDesktop(target); setError(""); } catch (failure) { setError(errorMessage(failure)); }
      }} />}
      <SettingsRow label="外部浏览器"><ExternalLink href={target.url} accessibilityLabel="在外部浏览器打开 Billion Context"
        onError={(failure) => setError(errorMessage(failure))}><Text style={{ color: theme.colors.accent }}>打开 dashboard</Text></ExternalLink></SettingsRow>
    </SettingsCard></SettingsSection>}
    {busy && <Text style={hint}>正在读取{params.agentId ? "会话映射" : "工作区"}…</Text>}
    {error ? <View style={{ gap: 8 }}><Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{error}</Text>
      <Text style={hint}>请在 Zeonest 的 Billion Context 配置中检查实例地址。inline 模式使用随机端口，需要填写实际监听地址；不会跳转到最近会话。</Text></View> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={hint}>{message}</Text> : null}
    <Text style={hint}>浏览器运行在客户端。远程宿主请配置客户端可达的地址或安全隧道；127.0.0.1 始终指浏览器所在设备。本功能不会启动 billion-context 或建立隧道。</Text>
  </ScrollView>;
}
