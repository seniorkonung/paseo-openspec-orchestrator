import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const openSpecAvailability = defineRpc({
  name: "openspec.availability",
  input: z.object({
    workspaceId: z.string().trim().min(1).max(512),
  }),
  output: z.object({
    installed: z.boolean(),
  }),
});
