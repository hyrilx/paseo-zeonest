import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, SidebarRow, TextInput } from "@getpaseo/plugin/client/ui";
import { catalogRows, type CatalogRow, type NoteSource } from "./catalog";
import type { NoteLibrary } from "./library";
import { NotesPanel } from "./panel";

const screenId = "conversation-notes-hub";
type Colors = PluginScreenProps["theme"]["colors"];
const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
  column: { alignSelf: "center", width: "100%", maxWidth: 820 },
  header: { gap: 14, paddingBottom: 6 },
  section: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36 },
  title: { fontSize: 14, lineHeight: 20, fontWeight: "600", flexShrink: 1 },
  bodyText: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 9, borderWidth: 1, borderRadius: 7, minHeight: 36 },
  input: { flex: 1, minWidth: 0, paddingVertical: 6, paddingRight: 8, fontSize: 13, lineHeight: 19 },
  action: { alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 5, minWidth: 36, minHeight: 36, borderRadius: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 8, paddingHorizontal: 8, minHeight: 54, borderBottomWidth: StyleSheet.hairlineWidth },
  meta: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  rowCopy: { flex: 1, minWidth: 0, gap: 2 },
  detail: { gap: 8 },
  message: { paddingHorizontal: 8, paddingVertical: 10 },
});

function Action({ label, icon, press, colors, visible = false, disabled = false }: {
  label: string; icon: string; press(): void; colors: Colors; visible?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={press} style={({ pressed }) => [styles.action, { paddingHorizontal: visible ? 7 : 0, opacity: disabled ? 0.55 : 1,
      backgroundColor: pressed ? colors.surface2 : undefined }]}>
    <Icon name={icon} size={16} color={visible ? colors.accent : colors.foregroundMuted} />
    {visible && <Text style={[styles.bodyText, { color: colors.accent }]}>{label}</Text>}
  </Pressable>;
}

function Sidebar({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return <SidebarRow label="笔记" icon="NotebookPen" active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId })} />;
}

function SourceDetail({ source, library, back, ...props }: PluginScreenProps & { source: NoteSource; library: NoteLibrary; back(): void }) {
  const { theme, layout, navigation, host } = props;
  const { colors } = theme;
  // A shared controller keeps in-progress edits identical in the hub and composer.
  const [note] = useState(() => library.get(source.id));
  return <View style={[styles.fill, styles.detail]}>
    <View style={styles.section}>
      <Action label="返回笔记列表" icon="ArrowLeft" press={back} colors={colors} />
      <View style={styles.rowCopy}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: colors.foreground }]}>{source.title}</Text>
        {source.location || source.archived ? <Text numberOfLines={1} style={[styles.caption, { color: colors.foregroundMuted }]}>
          {[source.location, source.archived ? "已归档" : ""].filter(Boolean).join(" · ")}
        </Text> : null}
      </View>
      {navigation && <Action label="打开会话" icon="ArrowUpRight" visible colors={colors}
        press={() => navigation.openAgent({ agentId: source.id, serverId: host.id })} />}
    </View>
    <NotesPanel theme={theme} layout={layout} note={note} loadPreferences={library.loadPreferences} />
  </View>;
}

function Hub({ library, ...props }: PluginScreenProps & { library: NoteLibrary }) {
  const { theme, layout } = props;
  const { colors } = theme;
  const activity = useSyncExternalStore(library.subscribe, library.getActivity, library.getActivity);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<NoteLibrary["loadCatalog"]>>>();
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<NoteSource>();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void library.loadCatalog(controller.signal).then((result) => {
      if (!controller.signal.aborted) { setCatalog(result); setLoading(false); }
    }, () => {
      if (!controller.signal.aborted) { setFailed(true); setLoading(false); }
    });
    return () => controller.abort();
  }, [library, refresh]);

  const filter = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = catalog ? catalogRows(catalog, activity) : [];
    return filter ? all.filter(({ title, location, snippet }) => `${title}\n${location}\n${snippet}`.toLowerCase().includes(filter)) : all;
  }, [catalog, activity, filter]);
  const label = loading ? "正在读取会话笔记…" : filter ? "没有匹配的笔记" : "还没有会话笔记";
  const reload = () => setRefresh((value) => value + 1);
  const padding = layout.compact ? 12 : 20;
  return <View testID="conversation-notes-hub" style={[styles.fill, styles.column, { paddingHorizontal: padding, paddingVertical: layout.compact ? 8 : 12 }]}>
    {selected && <SourceDetail key={selected.id} {...props} source={selected} library={library} back={() => setSelected(undefined)} />}
    <View style={selected ? styles.hidden : styles.fill}>
      <FlatList<CatalogRow> style={styles.fill} keyboardShouldPersistTaps="handled" data={rows} keyExtractor={({ id }) => id}
      ListHeaderComponent={<View style={styles.header}>
        <NotesPanel theme={theme} layout={layout} title="全局笔记" bodyHeight={layout.compact ? 148 : 176}
          placeholder="写全局笔记…" note={library.globalNote} loadPreferences={library.loadPreferences} />
        <View>
          <View style={styles.section}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>会话笔记</Text>
            {!!catalog && <Text style={[styles.caption, { color: colors.foregroundMuted }]}>{rows.length}</Text>}
            <View style={styles.fill} />
            <Action label="刷新会话笔记" icon={loading ? "LoaderCircle" : "RefreshCw"} colors={colors} press={reload} disabled={loading} />
          </View>
          {(!!catalog || !!query) && <View style={[styles.search, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
            <Icon name="Search" size={15} color={colors.foregroundMuted} />
            <TextInput accessibilityLabel="搜索会话笔记" placeholder="搜索会话或笔记摘要" placeholderTextColor={colors.foregroundMuted}
              autoCapitalize="none" autoCorrect={false} value={query} onChangeText={setQuery} style={[styles.input, { color: colors.foreground }]} />
            {!!query && <Action label="清除搜索" icon="X" colors={colors} press={() => setQuery("")} />}
          </View>}
          {failed && <View style={styles.section}>
            <Text accessibilityLiveRegion="polite" style={[styles.bodyText, { color: colors.statusDanger }]}>会话笔记读取失败</Text>
            <Action label="重试" icon="RefreshCw" colors={colors} press={reload} visible />
          </View>}
        </View>
      </View>}
      ListEmptyComponent={failed ? null : <Text accessibilityLiveRegion="polite" style={[styles.caption, styles.message, { color: colors.foregroundMuted }]}>{label}</Text>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`查看笔记：${item.title}`}
        onPress={() => { Keyboard.dismiss(); setSelected(item); }}
        style={({ pressed }) => [styles.row, { borderBottomColor: colors.border, backgroundColor: pressed ? colors.surface1 : undefined }]}>
        <Icon name="FileText" size={15} color={colors.foregroundMuted} />
        <View style={styles.rowCopy}>
          <View style={styles.meta}>
            <Text numberOfLines={1} style={[styles.title, { color: colors.foreground }]}>{item.title}</Text>
            {item.draft && <Text style={[styles.caption, { color: colors.statusWarning }]}>草稿</Text>}
          </View>
          <Text numberOfLines={1} style={[styles.caption, { color: colors.foregroundMuted }]}>
            {[item.location, item.archived ? "已归档" : "", item.unreadable ? "笔记不可读取" : item.snippet].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Icon name="ChevronRight" size={15} color={colors.foregroundMuted} />
      </Pressable>} />
    </View>
  </View>;
}

export function registerHub(client: Pick<PluginClientContext, "addScreen" | "addSidebarHeaderItem">, library: NoteLibrary) {
  const removeScreen = client.addScreen({ id: screenId, title: "笔记", Component: (props) => <Hub key={props.host.id} {...props} library={library} /> });
  try {
    const removeSidebar = client.addSidebarHeaderItem({ id: screenId, title: "笔记", Component: Sidebar });
    return () => { removeSidebar(); removeScreen(); };
  } catch (error) { removeScreen(); throw error; }
}
