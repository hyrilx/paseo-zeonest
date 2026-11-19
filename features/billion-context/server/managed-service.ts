import { ManagedStore, type ManagedRecord } from "./managed-store";
import { createManagedPlatform, type ManagedPlatform, type OwnedIdentity } from "./managed-platform";
import type { ServiceAction, ServiceStatus } from "../shared/managed-contracts";

class PortOccupied extends Error {}
const originOf = (record: ManagedRecord) => "http://127.0.0.1:" + record.port;
const same = (a: OwnedIdentity, b: OwnedIdentity) => a.pid === b.pid && a.instanceId === b.instanceId && a.startedAt === b.startedAt;
export class ManagedService {
  private enabled = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<unknown> | undefined;
  private ensuring: Promise<OwnedIdentity & { origin: string }> | undefined;
  constructor(private readonly store = new ManagedStore(), private readonly platform: ManagedPlatform = createManagedPlatform()) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.work) return Promise.reject(new Error("服务控制操作正在进行，请刷新状态后重试"));
    const work = this.store.lock(run);
    this.work = work;
    void work.finally(() => { if (this.work === work) this.work = undefined; }).catch(() => {});
    return work;
  }
  async enable(command: string | Promise<string>, readCommand: () => Promise<string> = async () => command): Promise<void> {
    this.enabled = true;
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (!this.work && this.enabled) void readCommand().then((value) => this.ensure(value)).catch(() => {});
      }, 5000);
      this.timer.unref();
    }
    await this.ensure(await command);
  }
  async disable(): Promise<void> {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.work?.catch(() => {});
  }
  async close(): Promise<void> { await this.disable(); }

  async status(): Promise<ServiceStatus> {
    const record = await this.store.read();
    const base = { enabled: this.enabled, busy: !!this.work, revision: record?.revision ?? "none" };
    if (!record) return { ...base, phase: "unconfigured" };
    const health = await this.platform.probe(originOf(record));
    const fields = { ...base, origin: originOf(record), port: record.port, desired: record.desired, error: record.error };
    if (health && this.owns(record, health)) return { ...fields, phase: "running", ...health };
    if (health || (record.spawnedPid && this.platform.alive(record.spawnedPid))) return {
      ...fields, phase: "conflict", error: "地址或进程身份无法验证；不会接管、终止或另开其他实例",
    };
    if (!(await this.platform.available(record.port))) return { ...fields, phase: "conflict", error: "固定端口被其他进程占用；请排查占用，或确认后强制更换端口" };
    return { ...fields, phase: record.desired === "stopped" ? "stopped" : "error", error: record.error ?? (record.desired === "running" ? "托管服务未运行；启用时将在原端口重试" : undefined) };
  }
  private owns(record: ManagedRecord, health: OwnedIdentity): boolean {
    return record.identity ? same(record.identity, health)
      : record.spawnedPid === health.pid && !!record.launchedAt
        && health.startedAt >= record.launchedAt - 2000 && health.startedAt <= record.launchedAt + 12000;
  }
  ensure(command: string): Promise<OwnedIdentity & { origin: string }> {
    if (!this.enabled) return Promise.reject(new Error("Billion Context 未启用或已停止"));
    if (this.ensuring) return this.ensuring;
    const work = this.exclusive(async () => {
      let record = await this.store.read();
      if (record?.desired === "stopped") throw new Error("托管服务已手动停止，请先在配置页启动服务");
      // Only the first allocation may retry another port after a bind race.
      const first = !record;
      for (let attempt = 0; attempt < (first ? 3 : 1); attempt++) {
        record ??= await this.store.write({ format: 1, revision: "new", port: await this.platform.allocate(), desired: "running" });
        try { return await this.start(record, command); }
        catch (error) {
          if (!first || attempt === 2 || !(error instanceof PortOccupied)) throw error;
          record = await this.store.write({ format: 1, revision: "new", port: await this.platform.allocate(record.port), desired: "running" });
        }
      }
      throw new Error("首次端口分配冲突，请刷新后重试");
    });
    this.ensuring = work;
    void work.finally(() => { if (this.ensuring === work) this.ensuring = undefined; }).catch(() => {});
    return work;
  }
  private async start(record: ManagedRecord, command: string): Promise<OwnedIdentity & { origin: string }> {
    const origin = originOf(record);
    const health = await this.platform.probe(origin);
    if (health) {
      if (!this.owns(record, health)) throw new Error("固定端口对应其他实例；不会接管，请检查占用或强制更换端口");
      if (!record.identity || record.error || record.desired !== "running") await this.store.write({ ...record, desired: "running", identity: health, error: undefined });
      return { ...health, origin };
    }
    if (record.spawnedPid && this.platform.alive(record.spawnedPid)) throw new Error("已记录的 Bili 进程仍在运行但无法验证，拒绝重复启动");
    if (!(await this.platform.available(record.port))) throw new PortOccupied("固定端口被其他进程占用；不会静默换端口");
    record = await this.store.write({ ...record, desired: "running", identity: undefined, spawnedPid: undefined, launchedAt: this.platform.now(), error: undefined });
    let child;
    try {
      child = await this.platform.spawn(command, record.port);
      record = await this.store.write({ ...record, spawnedPid: child.pid });
      const deadline = this.platform.now() + 10000;
      while (this.platform.now() < deadline) {
        if (child.exited()) throw new Error("Bili 在就绪前退出，请检查可执行文件、版本与 Bili 自身日志");
        const ready = await this.platform.probe(origin);
        if (ready) {
          if (!this.owns(record, ready)) throw new Error("启动端口的实例身份与子进程不一致，拒绝使用");
          await this.store.write({ ...record, identity: ready, error: undefined });
          return { ...ready, origin };
        }
        await this.platform.sleep(150);
      }
      throw new Error("Bili 启动超过 10 秒仍未就绪；Pi 启动已阻止，请检查服务状态");
    } catch (error) {
      // This handle belongs to a child created by this attempt, never an unrelated PID.
      if (child && !child.exited()) child.terminate();
      await this.store.write({ ...record, error: error instanceof Error ? error.message : "Bili 启动失败" });
      if (child?.exited() && !(await this.platform.available(record.port))) throw new PortOccupied("Bili 绑定端口时发生冲突");
      throw error;
    }
  }
  private async stop(record: ManagedRecord, allowForeignPort = false): Promise<ManagedRecord> {
    const health = await this.platform.probe(originOf(record));
    if (health && !this.owns(record, health) && (!allowForeignPort || (record.spawnedPid && this.platform.alive(record.spawnedPid)))) {
      throw new Error("实例身份不匹配，拒绝终止其他进程");
    }
    if (health && this.owns(record, health)) {
      this.platform.signal(health.pid);
      const deadline = this.platform.now() + 6000;
      while (this.platform.alive(health.pid) && this.platform.now() < deadline) await this.platform.sleep(100);
      if (this.platform.alive(health.pid)) throw new Error("服务未在 6 秒内停止；未发送 SIGKILL，请检查服务后刷新");
    } else if (record.spawnedPid && this.platform.alive(record.spawnedPid)) {
      throw new Error("无法验证存活进程身份，拒绝仅按 PID 终止；请先排查服务");
    } else if (!allowForeignPort && !(await this.platform.available(record.port))) throw new Error("端口由其他进程占用，拒绝终止");
    return this.store.write({ ...record, desired: "stopped", identity: undefined, spawnedPid: undefined, launchedAt: undefined, error: undefined });
  }
  async control(action: ServiceAction, revision: string, command: string, confirmPortChange = false): Promise<ServiceStatus> {
    if (action !== "stop" && !this.enabled) throw new Error("请先启用并重载 Billion Context；关闭时仍可查看状态或停止已托管服务");
    await this.exclusive(async () => {
      let record = await this.store.read();
      if ((record?.revision ?? "none") !== revision) throw new Error("服务记录已改变，请刷新状态后重新确认操作");
      if (action === "rotate" && !confirmPortChange) throw new Error("更换端口必须明确确认，旧 Pi 会话需要重新打开");
      if (action === "stop") { if (record) await this.stop(record); return; }
      if (action === "restart" || action === "rotate") { if (record) record = await this.stop(record, action === "rotate"); }
      if (!record || action === "rotate") record = await this.store.write({ format: 1, revision: "new", port: await this.platform.allocate(record?.port), desired: "running" });
      await this.start({ ...record, desired: "running" }, command);
    });
    return this.status();
  }
}
export type ServiceManager = Pick<ManagedService, "enable" | "disable" | "close" | "ensure" | "status" | "control">;
