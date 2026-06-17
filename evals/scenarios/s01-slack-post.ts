import type { MountScenario } from '@agent-relay/evals'
import { EVAL_CHANNEL_ID, EVAL_CHANNEL_DIR } from '../fixture.js'

export const scenario: MountScenario = {
  id: 's01',
  title: 'Slack channel post',
  expectedPathPrefix: `.integrations/slack/channels/${EVAL_CHANNEL_DIR}/messages/`,
  task: `Send the message "Hello team, the deployment completed successfully." to the #general Slack channel.
Channel mount directory: ${EVAL_CHANNEL_DIR} (channelId: ${EVAL_CHANNEL_ID})

Use the integration mount to dispatch this message.`,
}
