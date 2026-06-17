import type { MountScenario } from '@agent-relay/evals'

export const scenario: MountScenario = {
  id: 's03',
  title: 'Linear issue creation',
  expectedPathPrefix: '.integrations/linear/issues/',
  task: `Create a Linear issue with the following details:
Title: "Fix mobile login crash on iOS 17"
Description: "Users on iOS 17 report the app crashes immediately when trying to log in. Reproducible 100% on iPhone 14. Priority: urgent."

Use the integration mount to create this issue.`,
}
