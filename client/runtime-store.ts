export interface RuntimeState {
  status: "loading" | "ready" | "error";
  enabledIds: readonly string[];
  error: string | null;
}

/** One store per installation, never a module-global cross-host singleton. */
export function createRuntimeStore() {
  let state: RuntimeState = { status: "loading", enabledIds: [], error: null };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next: RuntimeState) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}
