export type FeedbackProbeProfile = {
  displayName?: string | null;
};

export function formatFeedbackProbeGreeting(profile: FeedbackProbeProfile | null): string {
  return `Hello, ${profile!.displayName!.trim()}`;
}
