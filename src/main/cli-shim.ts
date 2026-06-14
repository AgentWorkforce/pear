import { join } from 'path'

export function resolvePackagedFactoryFleetBin(appPath: string): string {
  const appRoot = appPath.endsWith('app.asar')
    ? appPath.slice(0, -'app.asar'.length) + 'app.asar.unpacked'
    : appPath
  return join(appRoot, 'packages', 'factory-sdk', 'bin', 'fleet.mjs')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildPearCliShim(exePath: string, appPath: string): string {
  const quotedExePath = shellQuote(exePath)
  const quotedFactoryBin = shellQuote(resolvePackagedFactoryFleetBin(appPath))

  return [
    '#!/bin/sh',
    'if [ "$1" = "factory" ]; then',
    `  ELECTRON_RUN_AS_NODE=1 exec ${quotedExePath} ${quotedFactoryBin} "$@"`,
    'fi',
    `exec ${quotedExePath} "$@"`,
    '',
  ].join('\n')
}
