import assert from "node:assert/strict";
import test from "node:test";
import {
  ChangeBranchError,
  assertPlanningBranchFor,
  changeBranchFor,
  changeIdFromBranch,
  parseChangeBranch,
  planningBranchFor,
} from "../server/change-branch.ts";

test("извлекает change ID только из точной root-ветки change/<kebab-case-id>", () => {
  assert.equal(parseChangeBranch("change/add-export"), "change/add-export");
  assert.equal(changeIdFromBranch("change/add-export"), "add-export");
  assert.equal(changeBranchFor("add-export"), "change/add-export");
  assert.equal(planningBranchFor("add-export"), "planning/add-export");
  assert.equal(
    assertPlanningBranchFor("planning/add-export", "add-export"),
    "planning/add-export",
  );
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
    () => assertPlanningBranchFor("planning/other-change", "add-export"),
    ChangeBranchError,
  );
});
