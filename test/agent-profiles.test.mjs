import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_AGENT_PROFILE_NAMES,
  resolveRequiredAgentProfiles,
} from "../server/agent-profiles.ts";

function profile(name, suffix = name) {
  return {
    id: `profile-${suffix}`,
    name,
    provider: "codex",
    model: "gpt-5.5",
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
  assert.equal(result.profiles.Ultra.id, "profile-8");
  assert.equal(result.profiles["Ultra Sandbox"].name, "  ultra sandbox  ");
});

test("возвращает все отсутствующие профили и не нормализует внутренние пробелы", () => {
  const profiles = REQUIRED_AGENT_PROFILE_NAMES.filter(
    (name) => name !== "Low" && name !== "Ultra Sandbox",
  ).map((name) => profile(name));
  profiles.push(profile("Ultra  Sandbox", "wrong-spacing"));

  const result = resolveRequiredAgentProfiles(profiles);

  assert.deepEqual(result, {
    kind: "invalid",
    missing: ["Low", "Ultra Sandbox"],
    ambiguous: [],
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
  });
});
