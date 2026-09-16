import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getOpenSpecAvailability } from "./server/openspec-availability";
import { openSpecAvailability } from "./shared/openspec-availability";

export default function contribute(server: PluginServerContext) {
  server.handle(openSpecAvailability, getOpenSpecAvailability);

  return () => {};
}
