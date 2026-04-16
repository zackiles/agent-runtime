import gcp from './gcp.ts'
import gcpRest from './gcp-rest.ts'
import { createControlPlaneClient } from './control-plane.ts'
import type { Platform } from './types.ts'
import { detect } from '../mode.ts'

const modeInfo = await detect()

let platform: Platform

switch (modeInfo.mode) {
  case 'server':
    platform = gcpRest
    break
  case 'remote':
    platform = createControlPlaneClient(modeInfo.controlPlaneUrl!)
    break
  default: {
    platform = modeInfo.authMethod === 'adc' ? gcpRest : gcp
    break
  }
}

export default platform
export type { Platform }
export type * from './types.ts'
export { modeInfo }
