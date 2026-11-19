import type { PluginClientContext } from "@getpaseo/plugin/client";

export type Agent = ReturnType<PluginClientContext["paseo"]["agents"]["ref"]>;
export type TimelineMessage = Parameters<Parameters<Agent["timeline"]["subscribe"]>[0]>[0];
export type TimelineItem = Extract<TimelineMessage["event"], { type: "timeline" }>["item"];
export type ToolItem = Extract<TimelineItem, { type: "tool_call" }>;
export type TimelinePage = Awaited<ReturnType<Agent["timeline"]["refetch"]>>;
export interface RecordEntry {
  item: TimelineItem;
  turnId?: string | null;
  seq: number;
  updatedSeq?: number;
  unsequenced?: boolean;
  timestamp?: string;
}
export type Kind = "create" | "delete" | "edit" | "read";
export interface Activity {
  id: string;
  callId: string;
  tool: string;
  path: string;
  kind: Kind;
  status: ToolItem["status"];
  turnId: string;
  seq: number;
  timestamp?: string;
  content?: string;
  diff?: string;
  note?: string;
  range?: string;
}
export interface Turn { id: string; number: number; title: string }
export interface Projection { activities: Activity[]; turns: Turn[] }
