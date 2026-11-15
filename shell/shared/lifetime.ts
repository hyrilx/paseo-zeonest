import type { PluginCleanup } from "@getpaseo/plugin";

/** Shell-internal ownership of native Paseo cleanup functions. */
export function createLifetime() {
  const cleanups: PluginCleanup[] = [];
  let closed = false;
  let disposal: Promise<void> | undefined;
  return {
    get closed() { return closed; },
    add(cleanup: PluginCleanup) {
      if (closed) throw new Error("Cannot register after Zeonest teardown");
      cleanups.push(cleanup);
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      closed = true;
      disposal = Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        cleanups.length = 0;
        if (errors.length) throw new AggregateError(errors, "Zeonest cleanup failed");
      });
      return disposal;
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
