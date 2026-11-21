import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { recoverQuestionnaire, type TimelineData } from "../shared/contracts";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { answerText, selectedLabels, type Questionnaire } from "./transform";

type Props = PluginTimelineItemProps<TimelineData>;

export function QuestionnaireRenderer(props: Props) {
  if ("callId" in props.item.data) return <RecoveredQuestionnaire {...props} lookup={props.item.data} />;
  return <QuestionnaireCard {...props} data={props.item.data} />;
}

function RecoveredQuestionnaire(props: Props & { lookup: { callId: string; summary: string } }) {
  const recover = useRpc(recoverQuestionnaire);
  const [requested, setRequested] = useState(false);
  const query = useQuery({
    queryKey: ["zeonest", "ask-user-question", props.host.id, props.agentId, props.lookup.callId, props.lookup.summary],
    queryFn: async () => {
      const data = await recover({ agentId: props.agentId, ...props.lookup });
      if (!data) throw new Error("原始选项暂不可用");
      return data;
    },
    enabled: requested, staleTime: Infinity, gcTime: 60_000, retry: 1, refetchOnWindowFocus: false,
  });
  return <QuestionnaireCard {...props} data={query.data ?? undefined} fallback={props.lookup.summary}
    onExpand={() => setRequested(true)} retry={query.isError ? () => { void query.refetch(); } : undefined}
    notice={query.isPending ? "正在读取原始选项…" : "原始选项不可用，以下保留原始问答。"} />;
}

function QuestionnaireCard({ data, fallback, notice, onExpand, retry, theme: { colors }, layout }: Props & {
  data?: Questionnaire; fallback?: string; notice?: string; onExpand?: () => void; retry?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  const questions = data?.questions ?? [];
  const result = data?.result;
  const status = !result ? "选项回顾" : result.error ? "出错" : result.cancelled ? "已取消"
    : result.answers.length < questions.length ? "部分回答" : "已回答";
  const active = hovered || expanded;
  const textStyle = { color: colors.foreground, fontSize: 14, lineHeight: 21 };
  const mutedStyle = { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 };

  return (
    <View testID="questionnaire" style={{ minWidth: 0, paddingBottom: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="问答选项回顾"
        accessibilityState={{ expanded }}
        onPress={() => { if (!expanded) onExpand?.(); setExpanded((value) => !value); }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => { setHovered(false); setPressed(false); }}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={{ paddingHorizontal: 8, paddingVertical: 4, minHeight: layout.platform === "web" ? 32 : 44,
          borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 4,
          backgroundColor: active ? colors.surface1 : undefined, opacity: pressed ? 0.9 : 1 }}
      >
        <View style={{ width: 22, height: 22, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name={expanded ? "ChevronDown" : hovered ? "ChevronRight" : "MessageCircleQuestion"}
            size={14} color={active ? colors.foreground : colors.foregroundMuted} />
        </View>
        <Text style={{ ...textStyle, color: active ? colors.foreground : colors.foregroundMuted }}>问答</Text>
        <Text style={{ ...mutedStyle, marginLeft: 4, flexShrink: 1, minWidth: 0,
          color: result?.error ? colors.statusDanger : colors.foregroundMuted }}>
          {data ? `${questions.length} 个问题 · ${status}` : status}
        </Text>
      </Pressable>
      {expanded ? (
        <View testID="questionnaire-details" style={{ marginLeft: 18, marginTop: 4, borderLeftWidth: 1,
          borderColor: colors.border, paddingLeft: layout.compact ? 10 : 14, paddingRight: 8,
          paddingTop: 8, paddingBottom: 8, gap: 16, minWidth: 0 }}>
          {!data ? <>
            <Text style={mutedStyle}>{notice}</Text>
            <Text selectable style={textStyle}>{fallback}</Text>
            {retry ? <Pressable accessibilityRole="button" accessibilityLabel="重试读取选项" onPress={retry}>
              <Text style={{ ...mutedStyle, color: colors.accent }}>重试读取选项</Text>
            </Pressable> : null}
          </> : null}
          {questions.map((question, index) => {
            const answer = result?.answers.find((entry) => entry.questionIndex === index);
            const selected = selectedLabels(answer);
            return (
              <View key={index} testID={`question-${index}`} style={{ gap: 8, minWidth: 0,
                borderTopWidth: index ? 1 : 0, borderColor: colors.border, paddingTop: index ? 16 : 0 }}>
                <Text style={mutedStyle}>
                  {question.header ? `${question.header} · ` : ""}{!question.options.length ? "自由回答" : question.multiSelect ? "多选" : "单选"}
                </Text>
                <Text selectable style={{ ...textStyle, fontWeight: "500" }}>Q{index + 1}. {question.question}</Text>
                {question.context ? <Text selectable style={mutedStyle}>{question.context}</Text> : null}
                {question.options.length ? <View style={{ gap: 10, paddingVertical: 4 }}>
                  {question.options.map((option, optionIndex) => {
                    const chosen = selected.includes(option.label);
                    const key = `${index}-${optionIndex}`;
                    return (
                      <View
                        key={optionIndex}
                        testID={`option-${key}`}
                        style={{ flexDirection: "row", gap: 8, minWidth: 0 }}
                      >
                        <View style={{ width: 18, minHeight: 21, alignItems: "center", justifyContent: "flex-start", paddingTop: 3, flexShrink: 0 }}>
                          {chosen ? <Icon name="Check" size={14} color={colors.accent} />
                            : <Text style={mutedStyle}>{optionIndex + 1}.</Text>}
                        </View>
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <Text selectable style={{ ...textStyle, color: chosen ? colors.accent : colors.foreground,
                            fontWeight: chosen ? "500" : "normal" }}>{option.label}{option.recommended ? "（推荐）" : ""}{chosen ? "（已选）" : ""}</Text>
                          {option.description ? <Text selectable style={mutedStyle}>{option.description}</Text> : null}
                          {option.preview !== undefined ? (
                            <>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`问题 ${index + 1} 选项 ${optionIndex + 1} 预览`}
                                accessibilityState={{ expanded: !!previews[key] }}
                                onPress={() => setPreviews((current) => ({ ...current, [key]: !current[key] }))}
                                style={{ alignSelf: "flex-start", paddingVertical: layout.platform === "web" ? 4 : 8,
                                  minHeight: layout.platform === "web" ? undefined : 44,
                                  flexDirection: "row", alignItems: "center", gap: 4 }}
                              >
                                <Icon name={previews[key] ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
                                <Text style={mutedStyle}>{previews[key] ? "收起预览" : "查看预览"}</Text>
                              </Pressable>
                              {previews[key] ? <Text selectable style={{ ...textStyle, padding: 8,
                                borderRadius: 4, backgroundColor: colors.surface1 }}>{option.preview}</Text> : null}
                            </>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </View> : null}
                <Text selectable style={{ ...textStyle, fontWeight: "500" }}>
                  A{index + 1}. {answer ? `${answer.kind === "custom" ? "自定义：" : ""}${answerText(answer)}` : "未回答"}
                </Text>
                {answer?.notes ? <Text selectable style={textStyle}>补充：{answer.notes}</Text> : null}
              </View>
            );
          })}
          {result?.globalNote ? <Text selectable style={textStyle}>整体补充：{result.globalNote}</Text> : null}
          {result?.error ? <Text selectable style={{ ...textStyle, color: colors.statusDanger }}>问答错误：{result.error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
