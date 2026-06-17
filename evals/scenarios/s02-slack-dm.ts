import type { MountScenario } from '@agent-relay/evals'
import { EVAL_USER_ID } from '../fixture.js'

export const scenario: MountScenario = {
  id: 's02',
  title: 'Slack direct message',
  expectedPathPrefix: `.integrations/slack/users/${EVAL_USER_ID}/messages/`,
  task: `Send a direct message to user ${EVAL_USER_ID} saying: "Hey, can we sync tomorrow about the project status?"

Use the integration mount to dispatch this DM.`,
}
