export type FeedbackProbeProfile = {
  displayName?: string | null
}

export function formatFeedbackProbeGreeting(profile: FeedbackProbeProfile | null): string {
  const displayName = profile?.displayName?.trim()
  return `Hello, ${displayName || 'there'}`
}
