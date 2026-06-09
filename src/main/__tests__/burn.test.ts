import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createBurnIngestDiagnosticFilter } from '../burn.ts'

const TOOL_RESULT_WARNING = [
  'before\n',
  '\u26a0 claude: 10 sessions logged tool calls without any observed tool_result content (1215 tool calls).\n',
  '  Likely cause: still running (result line not yet flushed) or killed mid-call.\n',
  '  Counts decay as later ingest passes pick up the result lines; sized hotspots\n',
  '  attribution falls back to user-turn block sizes (or even-split) until they heal.\n',
  'after\n'
].join('')

test('burn ingest diagnostic filter suppresses only RelayBurn tool-result warnings', () => {
  const filter = createBurnIngestDiagnosticFilter()

  const output = filter.filter(TOOL_RESULT_WARNING) + filter.flush()

  assert.equal(output, 'before\nafter\n')
  assert.equal(filter.suppressedCount(), 1)
})

test('burn ingest diagnostic filter tolerates chunked native writes', () => {
  const filter = createBurnIngestDiagnosticFilter()

  const chunks = [
    TOOL_RESULT_WARNING.slice(0, 18),
    TOOL_RESULT_WARNING.slice(18, 117),
    TOOL_RESULT_WARNING.slice(117, 250),
    TOOL_RESULT_WARNING.slice(250)
  ]
  const output = chunks.map((chunk) => filter.filter(chunk)).join('') + filter.flush()

  assert.equal(output, 'before\nafter\n')
  assert.equal(filter.suppressedCount(), 1)
})

test('burn ingest diagnostic filter preserves unrelated warnings', () => {
  const filter = createBurnIngestDiagnosticFilter()
  const warning = '[burn] warning: something else happened\n'

  const output = filter.filter(warning) + filter.flush()

  assert.equal(output, warning)
  assert.equal(filter.suppressedCount(), 0)
})
