import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Shell-internal startup snapshot; not a feature API. */
export const runtimeRpc = defineRpc({
  name: "zeonest.shell.runtime",
  input: z.object({}),
  output: z.object({
    enabledIds: z.array(z.string()),
    error: z.string().nullable(),
  }),
});
