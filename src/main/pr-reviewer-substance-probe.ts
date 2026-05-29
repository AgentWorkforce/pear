export interface ProbeProfile {
  displayName: string
}

export function formatProbeGreeting(profile: ProbeProfile): string {
  return `Welcome, ${profile.displayName.trim()}`
}
