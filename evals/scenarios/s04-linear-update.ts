import type { MountScenario } from '@agent-relay/evals'
import { EVAL_ISSUE_ID } from '../fixture.js'

export const scenario: MountScenario = {
  id: 's04',
  title: 'Linear issue update',
  expectedPathPrefix: '.integrations/linear/issues/',
  task: `Update the Linear issue with ID "${EVAL_ISSUE_ID}".
Change the title to "Fix mobile login crash on iOS 17 — RESOLVED" and set priority to 0 (no priority).

Use the integration mount to dispatch this update. Write a JSON file under .integrations/linear/issues/ with "_action": "update", the issue "id", and the fields to change.`,
}
