import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { discover } from "../shared/contracts";
import type { Run, Saved, Target } from "../shared/contracts";
import { addedTargets } from "./workbench-state";
import { errorMessage } from "./panel-ui";

type Result = { targets: Target[]; configurations: Saved[]; notices: string[] };

type Request = { probes: Run[] };

export function useDiscovery(workspaceId: string) {
  const get = useRpc(discover);
  const [snapshot, setSnapshot] = useState<{ result: Result; revision: number }>();
  const [saved, setSaved] = useState<Saved[]>([]);
  const savedChanged = useRef(0);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState("");
  const [feedback, setFeedback] = useState<{ added: string[]; limited: boolean }>();
  const invoke = useRef<(request: Request) => void>(() => {});
  const replaceSaved = useCallback((rows: Saved[]) => { savedChanged.current++; setSaved(rows); }, []);

  useEffect(() => {
    let cancelled = false;
    let previous: Result | undefined;
    let pending: Request | undefined;
    let failed: Run[] = [];
    let active = false;
    invoke.current = (request) => {
      if (pending) pending.probes.push(...request.probes);
      else pending = { probes: [...request.probes] };
      if (!active) void drain();
    };
    async function drain() {
      active = true;
      setBusy(true);
      setFailure("");
      while (!cancelled && pending) {
        const request: Request = pending;
        pending = undefined;
        const probes = [...failed, ...request.probes];
        const revision = savedChanged.current;
        try {
          const found = await get({ workspaceId });
          if (cancelled) return;
          if (probes.length) setFeedback({ added: addedTargets(previous?.targets ?? [], found.targets, probes),
            limited: probes.some((run) => run.confirmedTargetsLimited) || found.notices.some((notice) => notice.includes("工作区仅显示")) });
          previous = found;
          failed = [];
          setSnapshot((old) => ({ result: found, revision: (old?.revision ?? 0) + 1 }));
          if (revision === savedChanged.current) setSaved(found.configurations);
          setFailure("");
        } catch (error) {
          if (cancelled) return;
          failed = probes;
          setFailure(errorMessage(error));
        }
      }
      active = false;
      if (!cancelled) setBusy(false);
    }
    invoke.current({ probes: [] });
    return () => { cancelled = true; invoke.current = () => {}; };
  }, [get, workspaceId]);
  const refresh = useCallback((probes: Run[] = []) => invoke.current({ probes }), []);
  return { result: snapshot?.result, revision: snapshot?.revision, saved, replaceSaved, busy, failure, feedback, refresh };
}
