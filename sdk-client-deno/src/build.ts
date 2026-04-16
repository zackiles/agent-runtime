import { load as loadRuntime } from './runtime.ts'

const rc = loadRuntime()
const BUILD_MODE = Deno.env.get('AR_BUILD_MODE') || rc.build.defaultMode
const BUILD_VERSION = Deno.env.get('AR_BUILD_VERSION') ||
  rc.build.defaultVersion
const BUILD_COMMIT = Deno.env.get('AR_BUILD_COMMIT') || 'unknown'
const BUILD_AUTHOR = Deno.env.get('AR_BUILD_AUTHOR') || 'unknown'
const BUILD_DATE = Deno.env.get('AR_BUILD_DATE') || 'unknown'
const BUILD_BRANCH = Deno.env.get('AR_BUILD_BRANCH') || 'unknown'

function isProduction(): boolean {
  return BUILD_MODE === 'production'
}

export {
  BUILD_AUTHOR,
  BUILD_BRANCH,
  BUILD_COMMIT,
  BUILD_DATE,
  BUILD_MODE,
  BUILD_VERSION,
  isProduction,
}
