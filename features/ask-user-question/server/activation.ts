let active: AbortController | undefined;

export function activate() {
  if (active) throw new Error("问答选项回顾已启动");
  const controller = new AbortController();
  active = controller;
  return () => {
    controller.abort();
    if (active === controller) active = undefined;
  };
}
export function activeSignal(): AbortSignal {
  if (!active || active.signal.aborted) throw new Error("问答选项回顾未启用或已停止");
  return active.signal;
}
