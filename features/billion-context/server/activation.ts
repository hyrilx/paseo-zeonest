let active: AbortController | undefined;

export function activate() {
  if (active) throw new Error("Billion Context 已启动");
  const controller = new AbortController();
  active = controller;
  return () => {
    controller.abort();
    if (active === controller) active = undefined;
  };
}
export function activeController() {
  if (!active || active.signal.aborted) throw new Error("Billion Context 未启用或已停止");
  return active;
}
