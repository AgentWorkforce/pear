import type { MountScenario } from '@agent-relay/evals'
import { scenario as s01 } from './s01-slack-post.js'
import { scenario as s02 } from './s02-slack-dm.js'
import { scenario as s03 } from './s03-linear-create.js'
import { scenario as s04 } from './s04-linear-update.js'
import { scenario as s05 } from './s05-linear-comment.js'
import { scenario as s06 } from './s06-linear-delete.js'

export const SCENARIOS: MountScenario[] = [s01, s02, s03, s04, s05, s06]

export function scenarioById(id: string): MountScenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
