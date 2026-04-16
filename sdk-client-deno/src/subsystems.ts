const SUBSYSTEMS = ['cursor', 'claude', 'gemini'] as const

type Subsystem = (typeof SUBSYSTEMS)[number]

const DEFAULT_SUBSYSTEM: Subsystem = 'cursor'

function isSubsystem(value: string): value is Subsystem {
  return SUBSYSTEMS.includes(value as Subsystem)
}

export { DEFAULT_SUBSYSTEM, isSubsystem, SUBSYSTEMS }
export type { Subsystem }
