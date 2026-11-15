import { useSettings, type PluginHostProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { parseHistory, type HistoryEntry, type HistoryMessage } from "./parse";
import { defaultPreferences, preferences, type Preferences } from "../shared/settings";

type Appearance = Pick<PluginHostProps, "theme" | "layout">;
type Display = { options: Preferences };

function EntryBody({ entry, theme, options }: { entry: HistoryEntry } & Pick<Appearance, "theme"> & Display) {
  const [full, setFull] = useState(false);
  const long = options.previewLength > 0 && entry.text.length > options.previewLength;
  const preview = long && !full;
  const text = preview ? entry.text.slice(0, options.previewLength) : entry.text;
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      {entry.role === "assistant" && !entry.text.includes("<chat-history-summary>") ? (
        <Markdown>{text}</Markdown>
      ) : (
        <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 22 }}>
          {text}
        </Text>
      )}
      {preview ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>…</Text> : null}
      {long ? (
        <Pressable accessibilityRole="button" accessibilityLabel={full ? "收起全文" : "展开全文"}
          accessibilityState={{ expanded: full }} onPress={() => setFull((value) => !value)} style={{ minHeight: 36, justifyContent: "center", alignSelf: "flex-start" }}>
          <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{full ? "收起全文" : "展开全文"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ActionEntry({ entry, theme, options }: { entry: HistoryEntry } & Pick<Appearance, "theme"> & Display) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 12, gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Action · ${entry.label}`}
        accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", minHeight: 40, gap: 8, minWidth: 0 }}>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
        <Icon name="Wrench" size={14} color={theme.colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Action · {entry.label}</Text>
          {!expanded && entry.text ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{entry.text}</Text> : null}
        </View>
      </Pressable>
      {expanded ? entry.text ? <EntryBody entry={entry} theme={theme} options={options} /> : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>摘要未保留操作详情。</Text>
      ) : null}
    </View>
  );
}

function ConversationEntry({ entry, theme, layout, options }: { entry: HistoryEntry } & Appearance & Display) {
  if (entry.role === "action") return <ActionEntry entry={entry} theme={theme} options={options} />;
  const user = entry.role === "user";
  const meta = entry.role === "meta";
  return (
    <View testID={`chat-history-${entry.role}`} style={{
      alignSelf: user ? "flex-end" : "stretch", maxWidth: user && !layout.compact ? "90%" : "100%",
      minWidth: 0, gap: 8, padding: user || meta ? (layout.compact ? 12 : 16) : 0,
      backgroundColor: user ? theme.colors.surface2 : meta ? theme.colors.surface0 : undefined,
      borderRadius: 10, borderLeftWidth: user ? 2 : 0, borderLeftColor: theme.colors.accent,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={user ? "User" : meta ? "Info" : "Bot"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{entry.label}</Text>
      </View>
      <EntryBody entry={entry} theme={theme} options={options} />
    </View>
  );
}

function HistorySection({ text, index, theme, layout, options }: { text: string; index: number } & Appearance & Display) {
  const history = useMemo(() => parseHistory(text), [text]);
  const [expandedOverride, setExpanded] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? options.defaultExpanded;
  const [raw, setRaw] = useState(false);
  const [pages, setPages] = useState(1);
  const visible = pages * options.pageSize;
  const messages = history.entries.filter((entry) => entry.role === "user" || entry.role === "assistant").length;
  const actions = history.entries.filter((entry) => entry.role === "action").length;
  const title = `Chat history${index ? ` ${index + 1}` : ""}`;
  const remaining = Math.max(0, history.entries.length - visible);
  return (
    <View testID="chat-history-section" style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, minWidth: 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: layout.compact ? 12 : 16, minHeight: 52 }}>
        <Icon name="History" size={18} color={theme.colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{title} · 前序对话</Text>
          {history.source ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{history.source}</Text> : null}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{messages} 条消息 · {actions} 项操作 · {expanded ? "点击收起" : "点击展开"}</Text>
        </View>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
      </Pressable>
      {expanded ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, padding: layout.compact ? 12 : 16, gap: 16, minWidth: 0 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>来自分叉时的文本摘要；操作仅展示摘要中保留的信息。</Text>
          {history.omitted || history.truncated ? (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning, fontSize: 13 }}>
              {[history.omitted ? "Paseo 已省略更早的历史。" : "", history.truncated ? "部分消息已被 Paseo 截断。" : ""].filter(Boolean).join(" ")}
            </Text>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={raw ? "返回对话视图" : "查看摘要原文"}
            onPress={() => setRaw((value) => !value)} style={{ minHeight: 36, justifyContent: "center", alignSelf: "flex-start" }}>
            <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{raw ? "返回对话视图" : "查看摘要原文"}</Text>
          </Pressable>
          {raw ? (
            <Text selectable testID="chat-history-raw" style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 21 }}>{text}</Text>
          ) : history.entries.length ? (
            <>
              {history.entries.slice(0, visible).map((entry, entryIndex) => <ConversationEntry key={entryIndex} entry={entry} theme={theme} layout={layout} options={options} />)}
              {remaining ? (
                <Pressable accessibilityRole="button" accessibilityLabel="显示更多历史" onPress={() => setPages((value) => value + 1)}
                  style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}>
                  <Text style={{ color: theme.colors.accent, fontSize: 13 }}>显示后续 {Math.min(options.pageSize, remaining)} 条（剩余 {remaining} 条）</Text>
                </Pressable>
              ) : null}
            </>
          ) : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>这份历史摘要没有内容。</Text>}
        </View>
      ) : null}
    </View>
  );
}

function HistoryMessageContent({ data, theme, layout, options }: { data: HistoryMessage } & Appearance & Display) {
  // Remove blank separator lines left by the summary, keeping indentation and interior newlines.
  const body = data.body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
  return (
    <View style={{ gap: 16, minWidth: 0 }}>
      {data.histories.map((text, index) => <HistorySection key={index} text={text} index={index} theme={theme} layout={layout} options={options} />)}
      {body.trim() ? (
        <View testID="chat-history-current" style={{ alignSelf: "flex-end", maxWidth: "100%", minWidth: 0, flexShrink: 1, padding: 16, borderRadius: 16, borderTopRightRadius: 4, backgroundColor: theme.colors.surface2 }}>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 22 }}>{body}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function ChatHistoryRenderer({ agentId, item, theme, layout }: PluginTimelineItemProps<HistoryMessage>) {
  const settings = useSettings(preferences);
  const options = settings.status === "ready" ? settings.values : defaultPreferences;
  return <View style={{ gap: 8, minWidth: 0 }}>
    {settings.status === "invalid" || settings.status === "error" ? (
      <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
        历史显示配置读取失败，暂用默认值：{settings.error}。可在功能配置页重新读取。
      </Text>
    ) : null}
    <HistoryMessageContent key={agentId} data={item.data} theme={theme} layout={layout} options={options} />
  </View>;
}
