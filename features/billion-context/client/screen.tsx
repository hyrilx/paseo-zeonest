import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { openExternalUrl, useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { ExternalLink, ScrollView, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SidebarRow } from "@getpaseo/plugin/client/ui";
import { errorMessage, listDashboardWorkspaces, resolveDashboard, screenId } from "../shared/contracts";

export function DashboardSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="ChartPie" label="Billion Context" active={currentScreen?.screenId === screenId}
    onPress={() => openScreen({ screenId, params: { openedAt: String(Date.now()) } })} />;
}
export function DashboardScreen(props: PluginScreenProps) {
  // Every entry click and host/route change discards stale URLs and pending results.
  return <DashboardPage key={JSON.stringify([props.host.id, props.params.workspaceId, props.params.agentId, props.params.openedAt])} {...props} />;
}
function DashboardPage({ theme, layout, host, params, navigation }: PluginScreenProps) {
  const list = useRpc(listDashboardWorkspaces);
  const resolve = useRpc(resolveDashboard);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [workspaceId, setWorkspaceId] = useState(params.workspaceId ?? "");
  const [target, setTarget] = useState<{ url: string; workspaceId: string } | null>(null);
  const [instances, setInstances] = useState<string[]>([]);
  const [instanceOrigin, setInstanceOrigin] = useState("");
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
  async function openTarget(value: { url: string; workspaceId: string }) {
    if (openBrowser.current) {
      openBrowser.current({ ...value, serverId: host.id });
      return "已在工作区浏览器打开。";
    }
    await openExternalUrl(value.url);
    return "已请求在外部浏览器打开。";
  }
  async function loadTarget(id: string, selectedOrigin?: string) {
    if (lock.current) return;
    const request = ++generation.current;
    lock.current = true; setBusy(true); setError(""); setTarget(null); setMessage(""); setInstances([]); setInstanceOrigin("");
    try {
      const value = await resolve({ workspaceId: id, ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(selectedOrigin ? { instanceOrigin: selectedOrigin } : {}) });
      if (!mounted.current || generation.current !== request) return;
      if ("instances" in value) setInstances(value.instances);
      else {
        setTarget(value);
        const opened = await openTarget(value);
        if (mounted.current && generation.current === request) setMessage(opened);
      }
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
    setBusy(true); setError(""); setTarget(null); setInstances([]); setInstanceOrigin(""); setMessage("");
    let cancelled = false;
    if (params.agentId) {
      if (!params.workspaceId) { setError("缺少会话工作区，请从聊天框重新打开详情"); setBusy(false); }
      else void loadTarget(params.workspaceId);
    } else {
      void list({}).then((values) => {
        if (cancelled) return;
        setWorkspaces(values);
        // The SDK requires a workspace-owned browser tab. It does not scope the global dashboard.
        const id = values.find((entry) => entry.id === workspaceId)?.id ?? values[0]?.id ?? "";
        setWorkspaceId(id);
        if (id) void loadTarget(id);
        else { setError("暂无可用工作区；请先在此宿主创建工作区，再重新打开总览。"); setBusy(false); }
      }, (failure: unknown) => { if (!cancelled) { setError(errorMessage(failure)); setBusy(false); } });
    }
    return () => { cancelled = true; mounted.current = false; generation.current++; lock.current = false; };
  }, [reload]);
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ fontSize: 22, fontWeight: "600", color: theme.colors.foreground }}>Billion Context · {params.agentId ? "会话详情" : "总览"}</Text>
    <Text style={hint}>{navigation?.openBrowser ? "桌面端自动使用工作区浏览器，正常无需再次选择工作区。" : "此客户端自动使用外部浏览器；若被拦截，可使用下方链接。"}</Text>
    {!params.agentId && error && workspaces.length > 1 && <SettingsSection title="浏览器工作区"><SettingsCard>
      <SettingsSelect label="工作区" value={workspaceId} options={workspaces.map((entry) => ({ label: entry.name, value: entry.id }))}
        disabled={busy} onValueChange={(id) => {
          setWorkspaceId(id); setTarget(null); setInstances([]); setInstanceOrigin(""); setMessage(""); void loadTarget(id);
        }} />
      <SettingsRow label="工作区仅用于放置浏览器标签" hint="总览始终展示所选 billion-context 实例的全局数据。" />
    </SettingsCard></SettingsSection>}
    {instances.length > 1 && <SettingsSection title="选择 dashboard 实例"><SettingsCard>
      <SettingsRow label={params.agentId ? "多个实例收录了当前会话" : "发现多个可用实例"}
        hint="请选择要查看的实例。打开时会重新验证地址及会话；客户端访问地址如已配置，须指向所选实例。" />
      <SettingsSelect label="实例" value={instanceOrigin} disabled={busy}
        options={[{ label: "请选择实例", value: "" }, ...instances.map((origin) => ({ label: origin, value: origin }))]}
        onValueChange={setInstanceOrigin} />
      <SettingsAction label="打开选定实例" actionLabel="打开" disabled={busy || !instanceOrigin}
        onPress={() => { void loadTarget(workspaceId, instanceOrigin); }} />
    </SettingsCard></SettingsSection>}
    {target && <SettingsSection title="Dashboard"><SettingsCard>
      <SettingsRow label={params.agentId ? "已精确定位当前会话" : "Dashboard 总览"} hint={target.url} />
      <SettingsRow label="外部浏览器"><ExternalLink href={target.url} accessibilityLabel="在外部浏览器打开 Billion Context"
        onError={(failure) => setError(errorMessage(failure))}><Text style={{ color: theme.colors.accent }}>打开 dashboard</Text></ExternalLink></SettingsRow>
    </SettingsCard></SettingsSection>}
    <SettingsCard><SettingsAction label={params.agentId ? "重新定位当前会话" : "重新读取工作区"}
      actionLabel={busy ? "读取中…" : "重新打开"} disabled={busy || (!!params.agentId && !workspaceId)}
      onPress={() => { if (params.agentId) void loadTarget(workspaceId); else setReload((value) => value + 1); }} /></SettingsCard>
    {busy && <Text style={hint}>正在定位{params.agentId ? "当前会话" : "dashboard 总览"}…</Text>}
    {error ? <View style={{ gap: 8 }}><Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{error}</Text>
      <Text style={hint}>地址留空时读取宿主的实例记录与默认日志。未发现实例时可重新尝试，或在 Billion Context 配置中填写地址；不会跳转到最近会话。</Text></View> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={hint}>{message}</Text> : null}
    <Text style={hint}>浏览器运行在客户端。远程宿主请配置客户端可达的地址或安全隧道；127.0.0.1 始终指浏览器所在设备。本功能不会启动 billion-context 或建立隧道。</Text>
  </ScrollView>;
}
