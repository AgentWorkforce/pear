import { describe, expect, it } from 'vitest'
import { MAX_FOLDER_HISTORY, folderHistory, folderSuggestions, lastSegmentRange, machineFolders, parentFolder, withFolder } from './spawn-folders'

describe('folderHistory', () => {
  it('reads the old single-folder save and drops junk and duplicates', () => {
    expect(folderHistory('/Users/finn/code/pear/')).toEqual(['/Users/finn/code/pear'])
    expect(folderHistory(['/a/b', '/a/b/', 'relative', 3, ''])).toEqual(['/a/b'])
    expect(folderHistory(undefined)).toEqual([])
  })
})

describe('withFolder', () => {
  it('puts the folder first without repeating it, capped', () => {
    expect(withFolder(['/a', '/b'], '/b/')).toEqual(['/b', '/a'])
    expect(withFolder(['/a'], '')).toEqual(['/a'])
    const many = Array.from({ length: 20 }, (_, i) => `/p${i}`)
    expect(withFolder(many, '/new')).toHaveLength(MAX_FOLDER_HISTORY)
  })
})

describe('parentFolder', () => {
  it('returns the containing folder, never the root', () => {
    expect(parentFolder('/Users/finn/code/pear')).toBe('/Users/finn/code')
    expect(parentFolder('/pear')).toBeNull()
  })
})

describe('folderSuggestions', () => {
  it('offers used folders, then configured repositories beside them', () => {
    expect(folderSuggestions(['/Users/finn/code/pear'], ['AgentWorkforce/relay', 'AgentWorkforce/pear'])).toEqual([
      '/Users/finn/code/pear',
      '/Users/finn/code/relay'
    ])
  })

  it('does not guess a folder for a repository already checked out in a known folder', () => {
    expect(folderSuggestions(['/Users/finn/code/pear', '/Users/finn/wt/relay'], ['AgentWorkforce/relay'])).toEqual([
      '/Users/finn/code/pear',
      '/Users/finn/wt/relay'
    ])
  })

  it('cannot place repositories on a machine with no folder history', () => {
    expect(folderSuggestions([], ['AgentWorkforce/relay'])).toEqual([])
  })
})

describe('lastSegmentRange', () => {
  it('selects the project name', () => {
    const folder = '/Users/finn/code/pear'
    const [start, end] = lastSegmentRange(folder)
    expect(folder.slice(start, end)).toBe('pear')
    expect(lastSegmentRange('/Users/finn/code/')).toEqual([12, 16])
  })
})

describe('machineFolders', () => {
  it('puts folders picked here before ones the machine reports, once each', () => {
    expect(machineFolders(['/a/pear'], ['/a/relay', '/a/pear/', 'rel'])).toEqual(['/a/pear', '/a/relay'])
    expect(machineFolders(undefined, ['/srv/app'])).toEqual(['/srv/app'])
    expect(machineFolders('/old')).toEqual(['/old'])
  })
})
