import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

// React Native Web gives a View ref a DOM node at runtime; the native TS config
// does not include the DOM library.
interface WebViewNode {
  scrollTop: number;
  parentElement: WebViewNode | null;
  ownerDocument?: {
    defaultView: { getComputedStyle(node: WebViewNode): { overflowY: string } } | null;
    scrollingElement: WebViewNode | null;
  };
}

function findWebScroller(view: View | null) {
  const node = view as unknown as WebViewNode | null;
  const document = node?.ownerDocument;
  if (!node || !document?.defaultView) return null;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(document.defaultView.getComputedStyle(parent).overflowY)) return parent;
  }
  return document.scrollingElement;
}

export function useSettingsViewport(platform: PluginSurfaceProps["layout"]["platform"], screenId: string | null) {
  const view = useRef<View>(null);
  const listOffset = useRef(0);
  const liveNativeOffset = useRef(0);
  const previousScreen = useRef(screenId);
  const [width, setWidth] = useState(0);
  const [availableHeight, setAvailableHeight] = useState<number>();
  const window = useWindowDimensions();
  const web = platform === "web";

  const measureHeight = useCallback(() => {
    if (web) return;
    // Leave room for the host's page padding and the iOS bottom safe area.
    const bottomClearance = platform === "ios" ? 52 : 16;
    view.current?.measureInWindow((_x, y) => {
      setAvailableHeight(Math.max(160, window.height - Math.max(0, y) - bottomClearance));
    });
  }, [web, platform, window.height]);
  useLayoutEffect(measureHeight, [measureHeight, window.width]);

  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    if (nextWidth !== width) {
      setWidth(nextWidth);
      measureHeight();
    }
  };

  function rememberListOffset() {
    listOffset.current = web ? Math.max(0, findWebScroller(view.current)?.scrollTop ?? 0) : liveNativeOffset.current;
  }

  useLayoutEffect(() => {
    if (previousScreen.current === screenId) return;
    previousScreen.current = screenId;
    if (!web) return;
    // On web the settings page already has a scroll container. Use it without
    // depending on the host's class names, test IDs or React internals.
    const scroller = findWebScroller(view.current);
    if (scroller) scroller.scrollTop = screenId === null ? listOffset.current : 0;
  }, [screenId, web]);

  function render(content: ReactNode) {
    // Settings surfaces have no host scroll ref on native. Give each page its
    // own bounded scroll view and restore the list's offset on remount.
    const onListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      liveNativeOffset.current = Math.max(0, event.nativeEvent.contentOffset.y);
    };
    return (
      <View ref={view} collapsable={false} onLayout={onLayout}>
        {web ? content : (
          <ScrollView key={screenId ?? "list"} testID="zeonest-settings-scroll" nestedScrollEnabled
            keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            style={{ maxHeight: availableHeight ?? Math.max(160, window.height * 0.6), flexGrow: 0 }}
            contentOffset={{ x: 0, y: screenId === null ? listOffset.current : 0 }}
            onScroll={screenId === null ? onListScroll : undefined} scrollEventThrottle={16}>
            {content}
          </ScrollView>
        )}
      </View>
    );
  }

  return { width, rememberListOffset, render };
}
