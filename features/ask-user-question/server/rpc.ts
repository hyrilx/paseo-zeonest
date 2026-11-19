import type { PluginServerContext } from "@getpaseo/plugin/server";
import { recoverQuestionnaire } from "../shared/contracts";
import { activeSignal } from "./activation";
import { recover } from "./session";

export default function contribute(server: PluginServerContext) {
  let stopped = false;
  server.handle(recoverQuestionnaire, async (input, { paseo }) => {
    const signal = activeSignal();
    const check = () => {
      if (stopped || signal.aborted) throw new Error("问答选项回顾已停止");
    };
    check();
    const result = await recover(paseo, input, check);
    check();
    return result;
  });
  return () => { stopped = true; };
}
