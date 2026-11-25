import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  deletePrompt,
  listPrompts,
  savePrompt,
  type DeletePromptInput,
  type DeletePromptResult,
  type PromptDraft,
  type PromptRecord,
  type SavePromptInput,
  type SavePromptResult,
} from "../shared/contracts";

export interface PromptListState {
  status: "idle" | "loading" | "ready" | "error";
  prompts: readonly PromptRecord[];
  error: string | null;
}

export interface ApplyModalState {
  open: boolean;
  initialPromptId: string | null;
  draftOverride: PromptDraft | null;
  requestId: number;
  activeHostId: string | null;
}

export interface PromptLibrary {
  subscribeList(listener: () => void): () => void;
  getListState(): PromptListState;
  refresh(): Promise<readonly PromptRecord[]>;
  save(input: SavePromptInput): Promise<SavePromptResult>;
  remove(input: DeletePromptInput): Promise<DeletePromptResult>;

  subscribeModal(listener: () => void): () => void;
  getModalState(): ApplyModalState;
  registerModalHost(hostId: string): () => void;
  hasModalHost(): boolean;
  openApplyModal(options?: { promptId?: string; draft?: PromptDraft }): boolean;
  closeApplyModal(): void;

  dispose(): void;
}

type RpcClient = Pick<PluginClientContext, "rpc">;

function sortPrompts(prompts: readonly PromptRecord[]): PromptRecord[] {
  return [...prompts].sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name));
}

export function createPromptLibrary(client: RpcClient): PromptLibrary {
  let disposed = false;
  let listState: PromptListState = { status: "idle", prompts: [], error: null };
  let inflightRefresh: Promise<readonly PromptRecord[]> | null = null;
  const listListeners = new Set<() => void>();

  const mountedHosts: string[] = [];
  let modalState: ApplyModalState = {
    open: false,
    initialPromptId: null,
    draftOverride: null,
    requestId: 0,
    activeHostId: null,
  };
  const modalListeners = new Set<() => void>();

  function emitList() {
    for (const listener of listListeners) listener();
  }

  function emitModal() {
    for (const listener of modalListeners) listener();
  }

  function setListState(next: PromptListState) {
    if (disposed) return;
    listState = next;
    emitList();
  }

  function setModalState(next: ApplyModalState) {
    if (disposed) return;
    modalState = next;
    emitModal();
  }

  async function refresh(): Promise<readonly PromptRecord[]> {
    if (disposed) return [];
    if (inflightRefresh) return inflightRefresh;
    setListState({
      status: listState.status === "ready" ? "ready" : "loading",
      prompts: listState.prompts,
      error: null,
    });
    const run = client.rpc(listPrompts, {}).then(
      (result) => {
        const sorted = sortPrompts(result.prompts);
        setListState({ status: "ready", prompts: sorted, error: null });
        return sorted;
      },
      (error) => {
        const message = error instanceof Error ? error.message : "无法读取 Prompt 列表";
        setListState({ status: "error", prompts: listState.prompts, error: message });
        throw error;
      },
    );
    const clearInflight = () => {
      if (inflightRefresh === run) inflightRefresh = null;
    };
    inflightRefresh = run;
    void run.then(clearInflight, clearInflight);
    return run;
  }

  async function save(input: SavePromptInput): Promise<SavePromptResult> {
    if (disposed) throw new Error("Prompt 管理器已停止");
    const result = await client.rpc(savePrompt, input);
    if (disposed) return result;
    if (result.status === "saved") {
      const rest = listState.prompts.filter((item) => item.id !== result.prompt.id);
      setListState({ status: "ready", prompts: sortPrompts([...rest, result.prompt]), error: null });
    } else if (result.current) {
      const rest = listState.prompts.filter((item) => item.id !== result.current!.id);
      setListState({ status: "ready", prompts: sortPrompts([...rest, result.current]), error: null });
    } else if (input.id) {
      const rest = listState.prompts.filter((item) => item.id !== input.id);
      setListState({ status: "ready", prompts: rest, error: null });
    }
    return result;
  }

  async function remove(input: DeletePromptInput): Promise<DeletePromptResult> {
    if (disposed) throw new Error("Prompt 管理器已停止");
    const result = await client.rpc(deletePrompt, input);
    if (disposed) return result;
    if (result.status === "deleted" || result.status === "not-found") {
      const rest = listState.prompts.filter((item) => item.id !== input.id);
      setListState({ status: "ready", prompts: rest, error: null });
    } else if (result.status === "conflict") {
      const rest = listState.prompts.filter((item) => item.id !== result.current.id);
      setListState({ status: "ready", prompts: sortPrompts([...rest, result.current]), error: null });
    }
    return result;
  }

  function registerModalHost(hostId: string): () => void {
    if (!mountedHosts.includes(hostId)) mountedHosts.push(hostId);
    const nextActive = mountedHosts[0] ?? null;
    if (modalState.activeHostId !== nextActive) {
      setModalState({ ...modalState, activeHostId: nextActive });
    }
    return () => {
      const index = mountedHosts.indexOf(hostId);
      if (index >= 0) mountedHosts.splice(index, 1);
      const updatedActive = mountedHosts[0] ?? null;
      if (modalState.activeHostId !== updatedActive) {
        setModalState({ ...modalState, activeHostId: updatedActive });
      }
    };
  }

  function openApplyModal(options?: { promptId?: string; draft?: PromptDraft }): boolean {
    if (disposed) return false;
    setModalState({
      open: true,
      initialPromptId: options?.promptId ?? null,
      draftOverride: options?.draft ?? null,
      requestId: modalState.requestId + 1,
      activeHostId: mountedHosts[0] ?? null,
    });
    return mountedHosts.length > 0;
  }

  function closeApplyModal(): void {
    if (disposed || !modalState.open) return;
    setModalState({
      ...modalState,
      open: false,
      initialPromptId: null,
      draftOverride: null,
    });
  }

  return {
    subscribeList(listener) {
      listListeners.add(listener);
      return () => { listListeners.delete(listener); };
    },
    getListState: () => listState,
    refresh,
    save,
    remove,
    subscribeModal(listener) {
      modalListeners.add(listener);
      return () => { modalListeners.delete(listener); };
    },
    getModalState: () => modalState,
    registerModalHost,
    hasModalHost: () => mountedHosts.length > 0,
    openApplyModal,
    closeApplyModal,
    dispose() {
      disposed = true;
      inflightRefresh = null;
      mountedHosts.length = 0;
      listListeners.clear();
      modalListeners.clear();
    },
  };
}
