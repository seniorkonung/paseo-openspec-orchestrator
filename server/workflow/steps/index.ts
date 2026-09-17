import { checkAgentProfiles } from "./check-agent-profiles.ts";
import { checkGitBranch } from "./check-git-branch.ts";
import { checkGitWorktree } from "./check-git-worktree.ts";
import type { WorkflowStepDefinition } from "../types.ts";

/**
 * Единственное место, где регистрируются шаги workflow.
 * Добавляйте новую функцию-описание шага в `steps/` и включайте её сюда.
 */
export const OPEN_SPEC_WORKFLOW_STEPS: readonly WorkflowStepDefinition[] = Object.freeze([
  checkAgentProfiles,
  checkGitBranch,
  checkGitWorktree,
]);
