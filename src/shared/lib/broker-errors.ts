export interface BrokerErrorKeyInput {
  message: string
  projectId?: string
}

export function getBrokerErrorKey(entry: BrokerErrorKeyInput): string {
  return `${entry.projectId || 'global'}\0${entry.message}`
}
