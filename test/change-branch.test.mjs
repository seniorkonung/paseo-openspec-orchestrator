import assert from "node:assert/strict";
import test from "node:test";
import {
  ChangeBranchError,
  assertPlanningBranchFor,
  assertImplementationBranchFor,
  changeBranchFor,
  changeIdFromBranch,
  parseChangeBranch,
  planningBranchFor,
  initialPlanningBranchFor,
  phasePlanningBranchFor,
  implementationBranchForRun,
  parsePlanningBranch,
  parseImplementationBranch,
} from "../server/change-branch.ts";

test("извлекает change ID только из точной root-ветки change/<kebab-case-id>", () => {
  assert.equal(parseChangeBranch("change/add-export"), "change/add-export");
  assert.equal(changeIdFromBranch("change/add-export"), "add-export");
  assert.equal(changeBranchFor("add-export"), "change/add-export");
  assert.equal(planningBranchFor("add-export"), "planning/add-export/initial");
  assert.equal(
    assertPlanningBranchFor("planning/add-export/initial", "add-export"),
    "planning/add-export/initial",
  );
});

test("строит и разбирает initial, phase planning и монотонные implementation run ветки", () => {
  assert.equal(initialPlanningBranchFor("add-export"), "planning/add-export/initial");
  assert.equal(phasePlanningBranchFor("add-export", 2), "planning/add-export/phase-2");
  assert.equal(
    implementationBranchForRun("add-export", 2, 3),
    "implementation/add-export/phase-2/run-3",
  );
  assert.deepEqual(parsePlanningBranch("planning/add-export/initial"), {
    kind: "initial",
    changeId: "add-export",
  });
  assert.deepEqual(parsePlanningBranch("planning/add-export/phase-2"), {
    kind: "phase",
    changeId: "add-export",
    phaseNumber: 2,
  });
  assert.deepEqual(parseImplementationBranch("implementation/add-export/phase-2/run-3"), {
    kind: "phase",
    changeId: "add-export",
    phaseNumber: 2,
    runNumber: 3,
  });
  assert.equal(
    assertImplementationBranchFor("implementation/add-export/phase-2/run-3", "add-export"),
    "implementation/add-export/phase-2/run-3",
  );
  assert.throws(() => phasePlanningBranchFor("add-export", 0), ChangeBranchError);
  assert.throws(() => implementationBranchForRun("add-export", 1, 0), ChangeBranchError);
});

test("отклоняет main, detached, planning namespace и дополнительные сегменты", () => {
  for (const branch of [
    "",
    "main",
    "feature/add-export",
    "planning/add-export",
    "change/AddExport",
    "change/add_export",
    " change/add-export",
    "change/add-export ",
    "change/add/export",
    "change/-add-export",
    "change/add-export/",
  ]) {
    assert.throws(() => parseChangeBranch(branch), ChangeBranchError);
  }
  assert.throws(
    () => assertPlanningBranchFor("planning/other-change/initial", "add-export"),
    ChangeBranchError,
  );
  assert.throws(
    () => assertPlanningBranchFor("planning/add-export", "add-export"),
    ChangeBranchError,
  );
  assert.throws(
    () => assertImplementationBranchFor("implementation/add-export", "add-export"),
    ChangeBranchError,
  );
  assert.throws(
    () => parsePlanningBranch(`planning/add-export/phase-${"9".repeat(32)}`),
  );
  assert.throws(
    () => parseImplementationBranch(`implementation/add-export/phase-1/run-${"9".repeat(32)}`),
  );
});
