import type { PluginClientContext } from "@getpaseo/plugin/client";

export type Paseo = PluginClientContext["paseo"];
export type Agent = ReturnType<Paseo["agents"]["ref"]>;
export type AgentSnapshot = NonNullable<ReturnType<Agent["current"]>>;
export type TimelineMessage = Parameters<Parameters<Agent["timeline"]["subscribe"]>[0]>[0];
export type StreamEvent = TimelineMessage["event"];
export type TimelineItem = Extract<StreamEvent, { type: "timeline" }>["item"];
export type TimelinePage = Awaited<ReturnType<Agent["timeline"]["refetch"]>>;

export interface Counts {
  rounds: number;
  steps: number;
  tools: number;
}
export interface Measurements {
  modelMs: number | null;
  toolMs: number | null;
  ttftMs: number | null;
  averageTps: number | null;
  instantTps: number | null;
}
export interface StatsSnapshot extends Counts, Measurements {
  status: "loading" | "ready" | "error";
  partial: boolean;
  warning: string;
}
