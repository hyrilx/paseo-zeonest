import { useEffect } from "react";
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { PromptApplyModal } from "./apply-modal";
import { PromptManagerHub } from "./hub";
import { createPromptLibrary, type PromptLibrary } from "./library";

export const PROMPT_MANAGER_SCREEN_ID = "prompt-manager-hub";
export const PROMPT_MANAGER_SIDEBAR_ID = "prompt-manager-sidebar";
export const PROMPT_MANAGER_INSERT_COMMAND_ID = "prompt-manager-insert";
export const PROMPT_MANAGER_OPEN_COMMAND_ID = "prompt-manager-open";

function PromptSidebarItem({
  library,
  openScreen,
  currentScreen,
  theme,
  layout,
  host,
}: PluginSidebarItemProps & { library: PromptLibrary }) {
  const hostId = `sidebar:${host.id}`;
  useEffect(() => library.registerModalHost(hostId), [library, hostId]);

  return (
    <>
      <SidebarRow
        label="Prompt"
        icon="Sparkles"
        active={currentScreen?.screenId === PROMPT_MANAGER_SCREEN_ID}
        onPress={() => openScreen({ screenId: PROMPT_MANAGER_SCREEN_ID })}
      />
      <PromptApplyModal
        library={library}
        theme={theme}
        layout={layout}
        hostId={hostId}
        onOpenManager={() => openScreen({ screenId: PROMPT_MANAGER_SCREEN_ID })}
      />
    </>
  );
}

type PromptClient = Pick<
  PluginClientContext,
  "rpc" | "addScreen" | "addSidebarHeaderItem" | "addCommandCenterItem" | "openScreen"
>;

export function startPromptManager(client: PromptClient) {
  const library = createPromptLibrary(client);
  const cleanups: Array<() => void> = [];

  try {
    cleanups.push(
      client.addScreen({
        id: PROMPT_MANAGER_SCREEN_ID,
        title: "Prompt 管理器",
        Component: (props: PluginScreenProps) => (
          <PromptManagerHub key={props.host.id} {...props} library={library} />
        ),
      }),
    );

    cleanups.push(
      client.addSidebarHeaderItem({
        id: PROMPT_MANAGER_SIDEBAR_ID,
        title: "Prompt 管理器",
        Component: (props: PluginSidebarItemProps) => (
          <PromptSidebarItem {...props} library={library} />
        ),
      }),
    );

    cleanups.push(
      client.addCommandCenterItem({
        id: PROMPT_MANAGER_INSERT_COMMAND_ID,
        title: "Prompt：插入 Prompt",
        icon: "Sparkles",
        keywords: ["prompt", "提示词", "模板", "插入", "insert", "template"],
        context: "global",
        onSelect(context) {
          const openedInPlace = library.openApplyModal();
          if (!openedInPlace) {
            context.openScreen({
              screenId: PROMPT_MANAGER_SCREEN_ID,
              params: { modal: "apply", ts: String(Date.now()) },
            });
          }
        },
      }),
    );

    cleanups.push(
      client.addCommandCenterItem({
        id: PROMPT_MANAGER_OPEN_COMMAND_ID,
        title: "Prompt：管理模板",
        icon: "FileText",
        keywords: ["prompt", "提示词", "模板", "管理", "manager"],
        context: "global",
        onSelect(context) {
          context.openScreen({ screenId: PROMPT_MANAGER_SCREEN_ID });
        },
      }),
    );
  } catch (error) {
    for (const remove of cleanups.reverse()) remove();
    library.dispose();
    throw error;
  }

  return () => {
    for (const remove of cleanups.reverse()) remove();
    library.dispose();
  };
}
