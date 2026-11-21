import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View, type FlatList as NativeFlatList } from "react-native";
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, SidebarRow, TextInput } from "@getpaseo/plugin/client/ui";
import { catalogRows, defaultSort, sortOptions, type CatalogRow, type NoteSort } from "./catalog";
import type { NoteLibrary } from "./library";
import { NotesPanel } from "./panel";

const screenId = "conversation-notes-hub";
type Colors = PluginScreenProps["theme"]["colors"];
type ListRow = { kind: "controls" } | { kind: "empty" } | { kind: "note"; note: CatalogRow };
const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0, minHeight: 0 },
  page: { flex: 1, minHeight: 0 },
  columns: { flexDirection: "row", gap: 18, paddingHorizontal: 18, paddingVertical: 12 },
  left: { flex: 1, minWidth: 0, minHeight: 0 },
  right: { flex: 1, minWidth: 0, minHeight: 0, borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 18 },
  globalHeader: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 },
  controls: { paddingBottom: 8, gap: 4 },
  compactInset: { paddingHorizontal: 12 },
  section: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36 },
  title: { fontSize: 14, lineHeight: 20, fontWeight: "600", flexShrink: 1 },
  bodyText: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 9, borderWidth: 1, borderRadius: 7, minHeight: 36 },
  input: { flex: 1, minWidth: 0, paddingVertical: 6, paddingRight: 8, fontSize: 13, lineHeight: 19 },
  action: { alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 5, minWidth: 36, minHeight: 36, borderRadius: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 8, minHeight: 52, borderRadius: 6 },
  separator: { borderBottomWidth: StyleSheet.hairlineWidth },
  meta: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  rowCopy: { flex: 1, minWidth: 0, gap: 2 },
  editor: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 8, gap: 4 },
  source: { alignSelf: "flex-start" },
  message: { paddingHorizontal: 8, paddingVertical: 10 },
  sortPick: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 36, borderRadius: 6, paddingHorizontal: 8 },
});

function Action({ label, icon, press, colors, text, disabled = false }: {
  label: string; icon: string; press(): void; colors: Colors; text?: string; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={press} style={({ pressed }) => [styles.action, { paddingHorizontal: text ? 7 : 0, opacity: disabled ? 0.55 : 1,
      backgroundColor: pressed ? colors.surface2 : undefined }]}>
    <Icon name={icon} size={15} color={colors.foregroundMuted} />
    {text && <Text style={[styles.caption, { color: colors.foreground }]}>{text}</Text>}
  </Pressable>;
}

function matches(row: CatalogRow, filter: string) {
  return `${row.title}\n${row.location}\n${row.snippet}`.toLowerCase().includes(filter);
}

function Sidebar({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return <SidebarRow label="笔记" icon="NotebookPen" active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId })} />;
}

function SortOptions({ open, close, sort, change, colors }: {
  open: boolean; close(): void; sort: NoteSort; change(value: NoteSort): void; colors: Colors;
}) {
  return <Modal title="会话笔记排序" open={open} onOpenChange={(next) => { if (!next) close(); }}>
    <Modal.Content contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 6 }}>
      <View accessibilityRole="radiogroup" accessibilityLabel="排序字段">
        {sortOptions.map(({ key, label }) => {
          const selected = key === sort.key;
          return <Pressable key={key} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected }}
            aria-checked={selected} onPress={() => change(key === sort.key ? sort : { key, direction: key === "name" ? "asc" : "desc" })}
            style={({ pressed }) => [styles.sortPick, { backgroundColor: pressed || selected ? colors.surface2 : undefined }]}>
            <Text style={[styles.bodyText, { color: colors.foreground }]}>{label}</Text>
            {selected && <Icon name="Check" size={15} color={colors.accent} />}
          </Pressable>;
        })}
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel="排序方向" style={styles.section}>
        {(["asc", "desc"] as const).map((direction) => {
          const label = direction === "asc" ? "升序" : "降序";
          const selected = sort.direction === direction;
          return <Pressable key={direction} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected }}
            aria-checked={selected} onPress={() => change({ ...sort, direction })}
            style={({ pressed }) => [styles.sortPick, styles.fill, { gap: 6, borderWidth: 1, borderColor: colors.border,
              backgroundColor: pressed || selected ? colors.surface2 : undefined }]}>
            <Text style={[styles.bodyText, { color: colors.foreground }]}>{label}</Text>
            {selected && <Icon name="Check" size={15} color={colors.accent} />}
          </Pressable>;
        })}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="完成排序" onPress={close}
        style={({ pressed }) => [styles.sortPick, { alignSelf: "flex-end", backgroundColor: pressed ? colors.surface2 : undefined }]}>
        <Text style={[styles.bodyText, { color: colors.accent }]}>完成</Text>
      </Pressable>
    </Modal.Content>
  </Modal>;
}

function SourceEditor({ item, library, theme, layout, navigation, host }: PluginScreenProps & { library: NoteLibrary; item: CatalogRow }) {
  const [note] = useState(() => library.get(item.id));
  function openSource() { navigation?.openAgent({ agentId: item.id, serverId: host.id }); }
  return <View testID="conversation-note-expanded" style={styles.editor}>
    <NotesPanel theme={theme} layout={layout} note={note} loadPreferences={library.loadPreferences} bodyHeight={layout.compact ? 238 : 254} />
    {navigation && <View style={styles.source}>
      <Action label="打开会话" icon="ArrowUpRight" text="打开会话" colors={theme.colors} press={openSource} />
    </View>}
  </View>;
}

function Hub({ library, ...props }: PluginScreenProps & { library: NoteLibrary }) {
  const { theme, layout } = props;
  const { colors } = theme;
  const activity = useSyncExternalStore(library.subscribe, library.getActivity, library.getActivity);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<NoteLibrary["loadCatalog"]>>>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(defaultSort);
  const [sortOpen, setSortOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<CatalogRow>();
  const listRef = useRef<NativeFlatList<ListRow>>(null);
  const scrollOffset = useRef(0);
  const [globalHeight, setGlobalHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
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
    const all = catalog ? catalogRows(catalog, activity, sort, expanded) : [];
    return filter ? all.filter((row) => row.id === expanded?.id || matches(row, filter)) : all;
  }, [catalog, activity, filter, sort, expanded]);
  function returnToFirstResult() {
    const offset = layout.compact ? globalHeight : 0;
    if (scrollOffset.current > offset) listRef.current?.scrollToOffset({ offset, animated: false });
  }
  function search(text: string) {
    const active = rows.find((row) => row.id === expanded?.id);
    if (active && !matches(active, text.trim().toLowerCase())) setExpanded(undefined);
    setQuery(text);
    returnToFirstResult();
  }
  function changeSort(next: NoteSort) {
    if (next.key === sort.key && next.direction === sort.direction) return;
    setExpanded(undefined);
    setSort(next);
    returnToFirstResult();
  }
  const list = useMemo((): ListRow[] => [
    ...(layout.compact ? [{ kind: "controls" as const }] : []),
    ...rows.map((note) => ({ kind: "note" as const, note })),
    ...(rows.length || failed ? [] : [{ kind: "empty" as const }]),
  ], [layout.compact, rows, failed]);
  const label = loading ? "正在读取会话笔记…" : filter ? "没有匹配的笔记" : "还没有会话笔记";
  const sortLabel = sortOptions.find(({ key }) => key === sort.key)?.label;
  const reload = () => setRefresh((value) => value + 1);
  const global = <NotesPanel theme={theme} layout={layout} title="全局笔记" bodyHeight={layout.compact ? 290 : undefined}
    placeholder="写全局笔记…" note={library.globalNote} loadPreferences={library.loadPreferences} />;
  const controls = <View testID="conversation-notes-controls" style={[styles.controls, layout.compact && styles.compactInset, { backgroundColor: colors.surface0 }]}>
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>会话笔记</Text>
      {!!catalog && <Text style={[styles.caption, { color: colors.foregroundMuted }]}>{rows.length}</Text>}
      <View style={styles.fill} />
      <Action label={`排序：${sortLabel}，${sort.direction === "asc" ? "升序" : "降序"}`} text={sortLabel} icon={sort.direction === "asc" ? "ArrowUp" : "ArrowDown"}
        colors={colors} press={() => { Keyboard.dismiss(); setSortOpen(true); }} />
      <Action label="刷新会话笔记" icon={loading ? "LoaderCircle" : "RefreshCw"} colors={colors} press={reload} disabled={loading} />
    </View>
    <View style={[styles.search, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
      <Icon name="Search" size={15} color={colors.foregroundMuted} />
      <TextInput accessibilityLabel="搜索会话笔记" placeholder="搜索会话或笔记摘要" placeholderTextColor={colors.foregroundMuted}
        autoCapitalize="none" autoCorrect={false} value={query} onChangeText={search} style={[styles.input, { color: colors.foreground }]} />
      {!!query && <Action label="清除搜索" icon="X" colors={colors} press={() => search("")} />}
    </View>
    {failed && <View style={styles.section}>
      <Text accessibilityLiveRegion="polite" style={[styles.bodyText, { color: colors.statusDanger }]}>会话笔记读取失败</Text>
      <Action label="重试" icon="RefreshCw" text="重试" colors={colors} press={reload} />
    </View>}
  </View>;

  function renderRow(item: ListRow) {
    if (item.kind === "controls") return controls;
    if (item.kind === "empty") return <Text accessibilityLiveRegion="polite" style={[styles.caption, styles.message,
      layout.compact && styles.compactInset, { color: colors.foregroundMuted }]}>{label}</Text>;
    const { note } = item;
    const open = expanded?.id === note.id;
    return <View style={layout.compact && styles.compactInset}>
      <View style={[styles.separator, { borderBottomColor: colors.border }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`笔记：${note.title}`} accessibilityState={{ expanded: open }} aria-expanded={open}
          onPress={() => { Keyboard.dismiss(); setExpanded((row) => row?.id === note.id ? undefined : note); }}
          style={({ pressed }) => [styles.row, { backgroundColor: pressed || open ? colors.surface1 : undefined }]}>
          <Icon name="FileText" size={15} color={colors.foregroundMuted} />
          <View style={styles.rowCopy}>
            <View style={styles.meta}>
              <Text numberOfLines={1} style={[styles.title, { color: colors.foreground }]}>{note.title}</Text>
              {note.draft && <Text style={[styles.caption, { color: colors.statusWarning }]}>草稿</Text>}
            </View>
            <Text numberOfLines={1} style={[styles.caption, { color: colors.foregroundMuted }]}>
              {[note.location, note.archived ? "已归档" : "", note.unreadable ? "笔记不可读取" : note.snippet].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={15} color={colors.foregroundMuted} />
        </Pressable>
        {open && <SourceEditor {...props} library={library} item={note} />}
      </View>
    </View>;
  }

  return <View testID="conversation-notes-hub" style={[styles.page, !layout.compact && styles.columns]}>
    {!layout.compact && <View testID="conversation-notes-global-column" style={styles.left}>{global}</View>}
    <View style={layout.compact ? styles.fill : [styles.right, { borderLeftColor: colors.border }]}>
      {!layout.compact && controls}
      <FlatList<ListRow> ref={listRef} testID="conversation-notes-list" style={styles.fill} keyboardShouldPersistTaps="handled"
        nestedScrollEnabled removeClippedSubviews={false} scrollEventThrottle={32}
        onScroll={({ nativeEvent }) => { scrollOffset.current = nativeEvent.contentOffset.y; }}
        onLayout={layout.compact ? ({ nativeEvent }) => setViewportHeight(nativeEvent.layout.height) : undefined}
        contentContainerStyle={layout.compact ? { minHeight: viewportHeight + globalHeight } : undefined}
        ListHeaderComponent={layout.compact ? <View style={styles.globalHeader}
          onLayout={({ nativeEvent }) => setGlobalHeight(nativeEvent.layout.height)}>{global}</View> : undefined}
        stickyHeaderIndices={layout.compact ? [1] : undefined} data={list}
        keyExtractor={(row) => row.kind === "note" ? `note:${row.note.id}` : row.kind} renderItem={({ item }) => renderRow(item)} />
    </View>
    <SortOptions open={sortOpen} sort={sort} change={changeSort} close={() => setSortOpen(false)} colors={colors} />
  </View>;
}

export function registerHub(client: Pick<PluginClientContext, "addScreen" | "addSidebarHeaderItem">, library: NoteLibrary) {
  const removeScreen = client.addScreen({ id: screenId, title: "笔记", Component: (props) => <Hub key={props.host.id} {...props} library={library} /> });
  try {
    const removeSidebar = client.addSidebarHeaderItem({ id: screenId, title: "笔记", Component: Sidebar });
    return () => { removeSidebar(); removeScreen(); };
  } catch (error) { removeScreen(); throw error; }
}
