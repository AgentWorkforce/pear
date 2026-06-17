import type { MountScenario } from '@agent-relay/evals'
import { EVAL_ISSUE_ID } from '../fixture.js'

export const scenario: MountScenario = {
  id: 's06',
  title: 'Linear issue delete',
  expectedPathPrefix: '.integrations/linear/issues/',
  task: `Delete the Linear issue with ID "${EVAL_ISSUE_ID}". It was created by mistake.

Use the integration mount to dispatch this deletion. Write a JSON file under .integrations/linear/issues/ with "_action": "delete" and the issue "id".`,
}
