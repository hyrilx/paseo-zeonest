import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Reload only this installation; callers cannot select another plugin or host. */
export const reloadRpc = defineRpc({
  name: "zeonest.shell.reload",
  input: z.object({}),
  output: z.object({ error: z.string().nullable() }),
});
