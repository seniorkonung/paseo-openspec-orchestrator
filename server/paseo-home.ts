import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolvePaseoHome(environment: NodeJS.ProcessEnv = process.env): string {
  // Совпадает с правилом Paseo: PASEO_HOME либо ~/.paseo.
  // Источник: https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/paseo-home.ts
  const input = environment.PASEO_HOME ?? "~/.paseo";
  if (input === "~") return homedir();
  return resolve(input.startsWith("~/") ? join(homedir(), input.slice(2)) : input);
}
