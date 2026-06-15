import type { RelayFileClient } from '@relayfile/sdk'

export interface WebhookRegistrarConfig {
  client: RelayFileClient
  workspaceId: string
  receiverUrl: string
  secret: string
  pathGlobs?: string[]
}

export class WebhookRegistrar {
  readonly #config: WebhookRegistrarConfig
  #subscriptionId?: string

  constructor(config: WebhookRegistrarConfig) {
    this.#config = config
  }

  async register(): Promise<void> {
    const pathGlobs = this.#config.pathGlobs ?? [
      '/linear/issues/**',
      '/slack/channels/**',
      '/github/repos/**',
    ]
    const subscription = await this.#config.client.registerWebhook({
      workspaceId: this.#config.workspaceId,
      url: this.#config.receiverUrl,
      pathGlobs,
      secret: this.#config.secret,
    })
    this.#subscriptionId = subscription.subscriptionId
  }

  async unregister(): Promise<void> {
    if (!this.#subscriptionId) return
    await this.#config.client.deleteWebhook(
      this.#config.workspaceId,
      this.#subscriptionId,
    )
    this.#subscriptionId = undefined
  }

  get subscriptionId(): string | undefined {
    return this.#subscriptionId
  }
}
