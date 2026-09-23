import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  ChangeBranchError,
  assertImplementationBranchFor,
  assertPlanningBranchFor,
  changeBranchFor,
  changeIdFromBranch,
  implementationBranchForRun,
  initialPlanningBranchFor,
  parseChangeBranch,
  phasePlanningBranchFor,
  planningBranchSchema,
  implementationBranchSchema,
} from "../server/change-branch.ts";

test("все этапы используют только корневую ветку change", () => {
  const branch = "change/add-export";
  assert.equal(changeBranchFor("add-export"), branch);
  assert.equal(initialPlanningBranchFor("add-export"), branch);
  assert.equal(phasePlanningBranchFor("add-export", 2), branch);
  assert.equal(implementationBranchForRun("add-export", 2, 3), branch);
  assert.equal(assertPlanningBranchFor(branch, "add-export"), branch);
  assert.equal(assertImplementationBranchFor(branch, "add-export"), branch);
  assert.equal(changeIdFromBranch(branch), "add-export");
  assert.equal(parseChangeBranch(branch), branch);
  assert.equal(planningBranchSchema.parse(branch), branch);
  assert.equal(implementationBranchSchema.parse(branch), branch);
  assert.ok(z.toJSONSchema(planningBranchSchema));
});

test("дочерние имена, main и неверные номера фазы отклоняются", () => {
  for (const branch of ["main", "planning/add-export/initial", "implementation/add-export/phase-1/run-1", "change/add-export/extra"]) {
    assert.throws(() => parseChangeBranch(branch), ChangeBranchError);
  }
  assert.throws(() => assertPlanningBranchFor("change/other", "add-export"), ChangeBranchError);
  assert.throws(() => phasePlanningBranchFor("add-export", 0), ChangeBranchError);
  assert.throws(() => implementationBranchForRun("add-export", 1, 0), ChangeBranchError);
});
