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

export const REQUIRED_AGENT_PROFILE_FIELDS = Object.freeze([
  "provider",
  "model",
  "modeId",
  "thinkingOptionId",
] as const);

export type RequiredAgentProfileField = (typeof REQUIRED_AGENT_PROFILE_FIELDS)[number];

export type CompleteRequiredAgentProfile = Omit<
  AgentProfile,
  RequiredAgentProfileField | "featureValues"
> &
  Readonly<Record<RequiredAgentProfileField, string>> & {
    readonly featureValues?: Readonly<Record<string, unknown>>;
  };

export type RequiredAgentProfiles = Readonly<
  Record<RequiredAgentProfileName, CompleteRequiredAgentProfile>
>;

export interface IncompleteRequiredAgentProfile {
  readonly name: RequiredAgentProfileName;
  readonly missingFields: readonly RequiredAgentProfileField[];
}

export type RequiredAgentProfilesResolution =
  | {
      readonly kind: "available";
      readonly profiles: RequiredAgentProfiles;
    }
  | {
      readonly kind: "invalid";
      readonly missing: readonly RequiredAgentProfileName[];
      readonly ambiguous: readonly RequiredAgentProfileName[];
      readonly incomplete: readonly IncompleteRequiredAgentProfile[];
    };

export type InvalidRequiredAgentProfilesResolution = Extract<
  RequiredAgentProfilesResolution,
  { kind: "invalid" }
>;

function normalizeProfileName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeRequiredField(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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
  const incomplete = REQUIRED_AGENT_PROFILE_NAMES.flatMap(
    (name): IncompleteRequiredAgentProfile[] => {
      const matchesForName = matches.get(name) ?? [];
      if (matchesForName.length !== 1) return [];
      const profile = matchesForName[0];
      const missingFields = REQUIRED_AGENT_PROFILE_FIELDS.filter(
        (field) => normalizeRequiredField(profile[field]) === null,
      );
      return missingFields.length === 0
        ? []
        : [{ name, missingFields: Object.freeze(missingFields) }];
    },
  );
  if (missing.length > 0 || ambiguous.length > 0 || incomplete.length > 0) {
    return {
      kind: "invalid",
      missing: Object.freeze(missing),
      ambiguous: Object.freeze(ambiguous),
      incomplete: Object.freeze(incomplete),
    };
  }

  const entries = REQUIRED_AGENT_PROFILE_NAMES.map((name) => {
    const profile = matches.get(name)?.[0];
    if (!profile) {
      throw new Error(`Профиль ${name} исчез после проверки полноты`);
    }
    const provider = normalizeRequiredField(profile.provider);
    const model = normalizeRequiredField(profile.model);
    const modeId = normalizeRequiredField(profile.modeId);
    const thinkingOptionId = normalizeRequiredField(profile.thinkingOptionId);
    if (!provider || !model || !modeId || !thinkingOptionId) {
      throw new Error(`Профиль ${name} стал неполным после проверки`);
    }
    const { featureValues, ...profileWithoutFeatures } = profile;
    const complete: CompleteRequiredAgentProfile = Object.freeze({
      ...profileWithoutFeatures,
      provider,
      model,
      modeId,
      thinkingOptionId,
      ...(featureValues == null
        ? {}
        : { featureValues: Object.freeze(Object.fromEntries(Object.entries(featureValues))) }),
    });
    return [name, complete] as const;
  });
  // Полнота record доказана проверками missing/ambiguous/incomplete выше.
  const resolved = Object.fromEntries(entries) as RequiredAgentProfiles;
  return { kind: "available", profiles: Object.freeze(resolved) };
}

export function describeRequiredAgentProfileProblems(
  resolution: InvalidRequiredAgentProfilesResolution,
): string {
  const problems: string[] = [];
  if (resolution.missing.length > 0) {
    problems.push(`Отсутствуют профили агентов: ${resolution.missing.join(", ")}`);
  }
  if (resolution.ambiguous.length > 0) {
    problems.push(`Неоднозначные профили агентов: ${resolution.ambiguous.join(", ")}`);
  }
  if (resolution.incomplete.length > 0) {
    problems.push(
      `Неполные профили агентов: ${resolution.incomplete
        .map(({ name, missingFields }) => `${name} (${missingFields.join(", ")})`)
        .join("; ")}`,
    );
  }
  return problems.join("; ");
}
