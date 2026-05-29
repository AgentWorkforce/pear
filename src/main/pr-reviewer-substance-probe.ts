export interface ProbeProfile {
  displayName?: string
}

export function formatProbeGreeting(profile: ProbeProfile | null): string {
  const normalized = profile ?? {}
  return `Hello, ${normalized.displayName!.trim()}`
}
