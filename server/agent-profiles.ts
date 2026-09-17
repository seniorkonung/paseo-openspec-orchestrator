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

export type RequiredAgentProfileResolution =
  | {
      readonly kind: "available";
      readonly profile: CompleteRequiredAgentProfile;
    }
  | {
      readonly kind: "invalid";
      readonly reason: "missing" | "ambiguous";
    }
  | {
      readonly kind: "invalid";
      readonly reason: "incomplete";
      readonly missingFields: readonly [
        RequiredAgentProfileField,
        ...RequiredAgentProfileField[],
      ];
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
  const resolutions = new Map(
    REQUIRED_AGENT_PROFILE_NAMES.map((name) => [
      name,
      resolveRequiredAgentProfile(profiles, name),
    ]),
  );
  const missing = REQUIRED_AGENT_PROFILE_NAMES.filter((name) => {
    const resolution = resolutions.get(name);
    return resolution?.kind === "invalid" && resolution.reason === "missing";
  });
  const ambiguous = REQUIRED_AGENT_PROFILE_NAMES.filter((name) => {
    const resolution = resolutions.get(name);
    return resolution?.kind === "invalid" && resolution.reason === "ambiguous";
  });
  const incomplete = REQUIRED_AGENT_PROFILE_NAMES.flatMap(
    (name): IncompleteRequiredAgentProfile[] => {
      const resolution = resolutions.get(name);
      return resolution?.kind === "invalid" && resolution.reason === "incomplete"
        ? [{ name, missingFields: resolution.missingFields }]
        : [];
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
    const resolution = resolutions.get(name);
    if (resolution?.kind !== "available") {
      throw new Error(`Профиль ${name} исчез после проверки полноты`);
    }
    return [name, resolution.profile] as const;
  });
  // Полнота record доказана проверками missing/ambiguous/incomplete выше.
  const resolved = Object.fromEntries(entries) as RequiredAgentProfiles;
  return { kind: "available", profiles: Object.freeze(resolved) };
}

export function resolveRequiredAgentProfile(
  profiles: readonly AgentProfile[],
  name: RequiredAgentProfileName,
): RequiredAgentProfileResolution {
  const matches = profiles.filter(
    (profile) => REQUIRED_NAME_BY_NORMALIZED.get(normalizeProfileName(profile.name)) === name,
  );
  if (matches.length === 0) {
    return { kind: "invalid", reason: "missing" };
  }
  if (matches.length > 1) {
    return { kind: "invalid", reason: "ambiguous" };
  }
  const profile = matches[0];
  const missingFields = REQUIRED_AGENT_PROFILE_FIELDS.filter(
    (field) => normalizeRequiredField(profile[field]) === null,
  );
  if (missingFields.length > 0) {
    return {
      kind: "invalid",
      reason: "incomplete",
      missingFields: Object.freeze(missingFields) as readonly [
        RequiredAgentProfileField,
        ...RequiredAgentProfileField[],
      ],
    };
  }

  const provider = normalizeRequiredField(profile.provider);
  const model = normalizeRequiredField(profile.model);
  const modeId = normalizeRequiredField(profile.modeId);
  const thinkingOptionId = normalizeRequiredField(profile.thinkingOptionId);
  if (!provider || !model || !modeId || !thinkingOptionId) {
    throw new Error(`Профиль ${name} стал неполным после проверки`);
  }
  const { featureValues, ...profileWithoutFeatures } = profile;
  return {
    kind: "available",
    profile: Object.freeze({
      ...profileWithoutFeatures,
      provider,
      model,
      modeId,
      thinkingOptionId,
      ...(featureValues == null
        ? {}
        : { featureValues: Object.freeze(Object.fromEntries(Object.entries(featureValues))) }),
    }),
  };
}

export function describeRequiredAgentProfileProblem(
  name: RequiredAgentProfileName,
  resolution: Extract<RequiredAgentProfileResolution, { kind: "invalid" }>,
): string {
  switch (resolution.reason) {
    case "missing":
      return `Отсутствует профиль агента: ${name}`;
    case "ambiguous":
      return `Неоднозначный профиль агента: ${name}`;
    case "incomplete":
      return `Неполный профиль агента: ${name} (${resolution.missingFields.join(", ")})`;
  }
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
