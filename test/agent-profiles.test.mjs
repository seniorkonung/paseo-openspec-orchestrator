import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_AGENT_PROFILE_NAMES,
  resolveRequiredAgentProfile,
  resolveRequiredAgentProfiles,
} from "../server/agent-profiles.ts";

function profile(name, suffix = name) {
  return {
    id: `profile-${suffix}`,
    name,
    provider: "codex",
    model: "gpt-5.5",
    modeId: "default",
    thinkingOptionId: "medium",
  };
}

test("разрешает все обязательные профили без учёта регистра и крайних пробелов", () => {
  const profiles = [...REQUIRED_AGENT_PROFILE_NAMES]
    .reverse()
    .map((name, index) =>
      profile(index % 2 === 0 ? `  ${name.toLowerCase()}  ` : name.toUpperCase(), index),
    );
  profiles.push(profile("Review", "extra"));

  const result = resolveRequiredAgentProfiles(profiles);

  assert.equal(result.kind, "available");
  assert.deepEqual(Object.keys(result.profiles), [...REQUIRED_AGENT_PROFILE_NAMES]);
  assert.equal(
    result.profiles.Ultra.id,
    `profile-${REQUIRED_AGENT_PROFILE_NAMES.length - 1}`,
  );
  assert.equal(
    result.profiles.High.name.trim().toLowerCase(),
    "high",
  );
});

test("возвращает все отсутствующие профили и не нормализует внутренние пробелы", () => {
  const profiles = REQUIRED_AGENT_PROFILE_NAMES.filter(
    (name) => name !== "Low" && name !== "Medium",
  ).map((name) => profile(name));
  profiles.push(profile("Med ium", "wrong-spacing"));

  const result = resolveRequiredAgentProfiles(profiles);

  assert.deepEqual(result, {
    kind: "invalid",
    missing: ["Medium", "Low"],
    ambiguous: [],
    incomplete: [],
  });
});

test("считает совпадающие обязательные имена неоднозначными, игнорируя посторонние", () => {
  const profiles = REQUIRED_AGENT_PROFILE_NAMES.map((name) => profile(name));
  profiles.push(profile(" high ", "duplicate-high"));
  profiles.push(profile("Review", "extra-1"), profile(" review ", "extra-2"));

  const result = resolveRequiredAgentProfiles(profiles);

  assert.deepEqual(result, {
    kind: "invalid",
    missing: [],
    ambiguous: ["High"],
    incomplete: [],
  });
});

test("отклоняет отсутствующие и пробельные обязательные настройки профиля", () => {
  const profiles = REQUIRED_AGENT_PROFILE_NAMES.map((name) => profile(name));
  Object.assign(profiles.find(({ name }) => name === "Ultra"), { provider: "   " });
  Object.assign(profiles.find(({ name }) => name === "High"), { model: undefined });
  Object.assign(profiles.find(({ name }) => name === "Medium"), { modeId: "\t" });
  Object.assign(profiles.find(({ name }) => name === "Low"), {
    thinkingOptionId: undefined,
  });

  const result = resolveRequiredAgentProfiles(profiles);

  assert.deepEqual(result, {
    kind: "invalid",
    missing: [],
    ambiguous: [],
    incomplete: [
      { name: "Ultra", missingFields: ["provider"] },
      { name: "High", missingFields: ["model"] },
      { name: "Medium", missingFields: ["modeId"] },
      { name: "Low", missingFields: ["thinkingOptionId"] },
    ],
  });
});

test("нормализует обязательные настройки и не требует featureValues", () => {
  const profiles = REQUIRED_AGENT_PROFILE_NAMES.map((name) => ({
    ...profile(name),
    provider: " codex ",
    model: " gpt-5.5 ",
    modeId: " default ",
    thinkingOptionId: " medium ",
  }));

  const result = resolveRequiredAgentProfiles(profiles);

  assert.equal(result.kind, "available");
  assert.deepEqual(
    {
      provider: result.profiles.Medium.provider,
      model: result.profiles.Medium.model,
      modeId: result.profiles.Medium.modeId,
      thinkingOptionId: result.profiles.Medium.thinkingOptionId,
      featureValues: result.profiles.Medium.featureValues,
    },
    {
      provider: "codex",
      model: "gpt-5.5",
      modeId: "default",
      thinkingOptionId: "medium",
      featureValues: undefined,
    },
  );
});

test("разрешает только запрошенный профиль и игнорирует проблемы остальных", () => {
  const profiles = [
    profile("Ultra"),
    { ...profile("Medium"), model: " " },
    profile("Medium", "duplicate-medium"),
  ];

  const result = resolveRequiredAgentProfile(profiles, "Ultra");

  assert.equal(result.kind, "available");
  assert.equal(result.profile.name, "Ultra");
  assert.equal(result.profile.provider, "codex");
});
