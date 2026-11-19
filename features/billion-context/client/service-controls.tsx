import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { errorMessage } from "../shared/contracts";
import { serviceControl, serviceStatus, type ServiceAction, type ServiceStatus } from "../shared/managed-contracts";

const phases = { unconfigured: "尚未分配端口", running: "运行中", stopped: "已手动停止", error: "服务未就绪", conflict: "端口或进程身份冲突" };
const titles = { stop: "停止服务", restart: "重启服务", rotate: "强制更换端口" };
type Confirmation = { action: Exclude<ServiceAction, "start">; revision: string };
export function ServiceControls({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const read = useRpc(serviceStatus), control = useRpc(serviceControl);
  const api = useRef({ read, control }); api.current = { read, control };
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState(""); const [pollError, setPollError] = useState(""); const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false); const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const mounted = useRef(false), sequence = useRef(0), controlling = useRef(false);
  async function refresh() {
    if (controlling.current) return;
    const request = ++sequence.current;
    try {
      const next = await api.current.read({});
      if (!mounted.current || request !== sequence.current) return;
      setStatus(next); setPollError("");
      setConfirmation((previous) => previous && previous.revision !== next.revision ? null : previous);
    } catch (failure) { if (mounted.current && request === sequence.current) setPollError(errorMessage(failure)); }
  }
  useEffect(() => {
    mounted.current = true; let timer: ReturnType<typeof setTimeout> | undefined; let cancelled = false;
    async function poll() { await refresh(); if (!cancelled) timer = setTimeout(() => { void poll(); }, 3000); }
    void poll();
    return () => { cancelled = true; mounted.current = false; sequence.current++; if (timer) clearTimeout(timer); };
  }, []);
  async function run(action: ServiceAction, revision: string) {
    if (controlling.current) return;
    controlling.current = true; const request = ++sequence.current;
    setBusy(true); setError(""); setMessage(""); setConfirmation(null);
    try {
      const next = await api.current.control({ action, revision, ...(action === "rotate" ? { confirmPortChange: true } : {}) });
      if (!mounted.current || request !== sequence.current) return;
      setStatus(next);
      setMessage(action === "rotate" ? "端口已更换。旧 Pi 会话仍使用旧地址，请在空闲时重新打开；本功能不会中断并重开对话。"
        : action === "stop" ? "服务已手动停止，不会自动拉起。启动新的 Pi 会话前请先启动服务。" : "服务已就绪，面板和新打开的 Pi 使用此固定地址。");
    } catch (failure) { if (mounted.current && request === sequence.current) setError(errorMessage(failure)); }
    finally { controlling.current = false; if (mounted.current && request === sequence.current) setBusy(false); }
  }
  const disabled = busy || !!status?.busy || !status;
  return <SettingsSection title="托管 Bili 服务"><View style={{ gap: 12 }}><SettingsCard>
    <SettingsRow label="服务运行状态" hint={status ? phases[status.phase] + (status.busy ? " · 操作进行中" : "") : "正在读取…"} />
    <SettingsRow label="固定服务地址" hint={status?.origin ?? "首次启动时分配随机可用端口"} />
    <SettingsRow label="进程与版本" hint={status?.pid ? "PID " + status.pid + " · " + (status.version ?? "版本未知") : "尚无已验证的托管进程"} />
    {status?.instanceId && <SettingsRow label="实例身份" hint={status.instanceId + (status.startedAt ? " · " + new Date(status.startedAt).toISOString() : "")} />}
    {status && !status.enabled && <SettingsRow label="子功能当前未启用" hint="仍可查看状态或停止已托管服务。启动、重启与更换端口需要先启用并重载插件。" />}
    <SettingsAction label="刷新服务状态" actionLabel="刷新" disabled={busy} onPress={() => { void refresh(); }} />
    <SettingsAction label="启动服务" actionLabel="启动" disabled={disabled || !status?.enabled || status.phase === "running"}
      onPress={() => { if (status) void run("start", status.revision); }} />
    {(["stop", "restart", "rotate"] as const).map((action) => <SettingsAction key={action} label={titles[action]} actionLabel={action === "rotate" ? "更换…" : "操作…"}
      disabled={disabled || (action !== "stop" && !status?.enabled) || status?.phase === "unconfigured" || (action === "stop" && status?.phase === "stopped")}
      onPress={() => { if (status) { setConfirmation({ action, revision: status.revision }); setMessage(""); } }} />)}
  </SettingsCard>
  {confirmation && <SettingsCard>
    <SettingsRow label={"确认" + titles[confirmation.action]} hint={confirmation.action === "rotate"
      ? "将停止已验证的托管进程并分配新端口。旧 Pi 仍持有旧地址，需要在空闲时重新打开；正在运行的请求可能失败。不会替你中断或重开会话。"
      : confirmation.action === "stop" ? "停止后会影响使用此服务的 Pi 请求，且不会自动重启。插件关闭或重载本身不会停止服务。"
      : "将停止并在原端口重启已验证的托管进程，期间使用此服务的 Pi 请求可能失败。"} />
    <SettingsAction label={"确认" + titles[confirmation.action]} actionLabel="确认" disabled={busy}
      onPress={() => { void run(confirmation.action, confirmation.revision); }} />
    <SettingsAction label="取消服务操作" actionLabel="取消" disabled={busy} onPress={() => setConfirmation(null)} />
  </SettingsCard>}
  {status?.error && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{status.error}</Text>}
  {pollError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{pollError}</Text> : null}
  {error ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  {message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
  <Text style={{ color: theme.colors.foregroundMuted }}>服务独立于插件生命周期。重载、关闭插件或退出 Paseo 后可能继续运行；需要停止时请使用上面的停止操作。只控制本功能已验证身份的进程。</Text>
  </View></SettingsSection>;
}
