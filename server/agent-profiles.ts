import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoConfig = Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"];

export type AgentProfile = NonNullable<PaseoConfig["agentProfiles"]>[number];
export type AgentProfileReader = () => Promise<readonly AgentProfile[]>;

export const REQUIRED_AGENT_PROFILE_NAMES = Object.freeze([
  "Ultra",
  "High",
  "Medium",
  "Low",
  "Ultra Sandbox",
  "High Sandbox",
  "Medium Sandbox",
  "Low Sandbox",
  "Orchestrator",
] as const);

export type RequiredAgentProfileName = (typeof REQUIRED_AGENT_PROFILE_NAMES)[number];

export type RequiredAgentProfiles = Readonly<
  Record<RequiredAgentProfileName, AgentProfile>
>;

export type RequiredAgentProfilesResolution =
  | {
      readonly kind: "available";
      readonly profiles: RequiredAgentProfiles;
    }
  | {
      readonly kind: "invalid";
      readonly missing: readonly RequiredAgentProfileName[];
      readonly ambiguous: readonly RequiredAgentProfileName[];
    };

function normalizeProfileName(name: string): string {
  return name.trim().toLowerCase();
}

const REQUIRED_NAME_BY_NORMALIZED = new Map<string, RequiredAgentProfileName>(
  REQUIRED_AGENT_PROFILE_NAMES.map((name) => [normalizeProfileName(name), name]),
);

/**
 * Разрешает обязательные имена в полные профили Paseo. Результат можно
 * переиспользовать в следующих шагах без повторения строковых имён.
 */
export function resolveRequiredAgentProfiles(
  profiles: readonly AgentProfile[],
): RequiredAgentProfilesResolution {
  const matches = new Map<RequiredAgentProfileName, AgentProfile[]>();
  for (const name of REQUIRED_AGENT_PROFILE_NAMES) matches.set(name, []);

  for (const profile of profiles) {
    const requiredName = REQUIRED_NAME_BY_NORMALIZED.get(normalizeProfileName(profile.name));
    if (requiredName !== undefined) matches.get(requiredName)?.push(profile);
  }

  const missing = REQUIRED_AGENT_PROFILE_NAMES.filter(
    (name) => matches.get(name)?.length === 0,
  );
  const ambiguous = REQUIRED_AGENT_PROFILE_NAMES.filter(
    (name) => (matches.get(name)?.length ?? 0) > 1,
  );
  if (missing.length > 0 || ambiguous.length > 0) {
    return {
      kind: "invalid",
      missing: Object.freeze(missing),
      ambiguous: Object.freeze(ambiguous),
    };
  }

  const entries = REQUIRED_AGENT_PROFILE_NAMES.map((name) => [
    name,
    matches.get(name)?.[0],
  ]);
  // Полнота record доказана проверками missing/ambiguous выше.
  const resolved = Object.fromEntries(entries) as RequiredAgentProfiles;
  return { kind: "available", profiles: Object.freeze(resolved) };
}
