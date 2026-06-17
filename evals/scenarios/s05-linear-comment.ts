import type { MountScenario } from '@agent-relay/evals'
import { EVAL_ISSUE_ID } from '../fixture.js'

export const scenario: MountScenario = {
  id: 's05',
  title: 'Linear issue comment',
  expectedPathPrefix: `.integrations/linear/issues/${EVAL_ISSUE_ID}/comments/`,
  task: `Add a comment to Linear issue "${EVAL_ISSUE_ID}".
Comment text: "Verified fix on iOS 17.2 — no longer reproducible. Closing."

Use the integration mount to post this comment. Write a JSON file under .integrations/linear/issues/${EVAL_ISSUE_ID}/comments/ with "issueId" and "body".`,
}
