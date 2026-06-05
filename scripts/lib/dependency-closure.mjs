import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function packagePath(nodeModulesPath, packageName) {
  return join(nodeModulesPath, ...packageName.split('/'), 'package.json')
}

export function readPackageLock(rootDir) {
  const lockPath = join(rootDir, 'package-lock.json')
  return JSON.parse(readFileSync(lockPath, 'utf8'))
}

function dependencyPackageKey(packages, fromPackageKey, dependencyName) {
  let currentDir = fromPackageKey
  while (true) {
    const candidate = `${currentDir}/node_modules/${dependencyName}`
    if (packages[candidate]) return candidate

    const parts = currentDir.split('/')
    const nodeModulesIndex = parts.lastIndexOf('node_modules')
    if (nodeModulesIndex === -1) return undefined

    currentDir = parts.slice(0, nodeModulesIndex).join('/')
    const parentCandidate = currentDir ? `${currentDir}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`
    if (packages[parentCandidate]) return parentCandidate
    if (!currentDir) return undefined
  }
}

export function dependencyClosurePackageKeys(rootDir, rootPackage = 'agent-relay') {
  const lock = readPackageLock(rootDir)
  const packages = lock.packages ?? {}
  const seen = new Set()

  function visit(packageKey) {
    if (seen.has(packageKey)) return
    const lockPackage = packages[packageKey]
    if (!lockPackage) throw new Error(`package-lock entry missing for ${packageKey}`)

    seen.add(packageKey)
    for (const dependency of [
      ...Object.keys(lockPackage.dependencies ?? {}),
      ...Object.keys(lockPackage.optionalDependencies ?? {})
    ]) {
      const dependencyKey = dependencyPackageKey(packages, packageKey, dependency)
      if (!dependencyKey) throw new Error(`package-lock entry missing for ${dependency} required by ${packageKey}`)
      visit(dependencyKey)
    }
  }

  visit(`node_modules/${rootPackage}`)
  return [...seen].sort()
}

export function dependencyClosure(rootDir, rootPackage = 'agent-relay') {
  return dependencyClosurePackageKeys(rootDir, rootPackage)
    .map((packageKey) => packageKey.replace(/^node_modules\//, ''))
}

export function installedDependencyClosure(rootDir, rootPackage = 'agent-relay') {
  const nodeModulesPath = join(rootDir, 'node_modules')
  return dependencyClosure(rootDir, rootPackage).filter((packageName) => {
    return existsSync(packagePath(nodeModulesPath, packageName))
  })
}

export function mcpExtraResourceFilters(rootDir) {
  return dependencyClosure(rootDir).map((packageName) => `${packageName}/**`)
}
