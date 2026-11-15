import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const shellSettings = defineSettings({
  id: "zeonest-shell",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.record(z.string(), z.boolean()).default({}),
  }),
});
