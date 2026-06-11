import { describe, expect, it } from 'vitest'

import { FakeMountClient } from './fakes'

describe('FakeMountClient', () => {
  it('clones stored and returned file content', async () => {
    const initialContent = { nested: { value: 'initial' } }
    const mount = new FakeMountClient({ '/file.json': initialContent })

    initialContent.nested.value = 'mutated-before-read'
    const firstRead = await mount.readFile('/file.json')
    expect(firstRead.content).toEqual({ nested: { value: 'initial' } })

    const firstReadContent = firstRead.content as { nested: { value: string } }
    firstReadContent.nested.value = 'mutated-after-read'
    const secondRead = await mount.readFile('/file.json')
    expect(secondRead.content).toEqual({ nested: { value: 'initial' } })

    const writeContent = { nested: { value: 'written' } }
    await mount.writeFile('/file.json', writeContent)
    writeContent.nested.value = 'mutated-after-write'
    const loggedContent = mount.writes[0].content as { nested: { value: string } }
    loggedContent.nested.value = 'mutated-in-log'

    const writtenRead = await mount.readFile('/file.json')
    expect(writtenRead.content).toEqual({ nested: { value: 'written' } })
  })
})
