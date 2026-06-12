import { LocalMirrorMountClient, type LocalMirrorMountClientConfig } from './local-mirror-mount-client'
import { RelayfileCloudMountClient, type RelayfileCloudMountClientConfig } from './relayfile-cloud-mount-client'

export type MountBackend = 'relayfile-cloud' | 'relayfile-mirror'

export type CreateMountConfig =
  | (RelayfileCloudMountClientConfig & { backend?: 'relayfile-cloud' })
  | (LocalMirrorMountClientConfig & { backend: 'relayfile-mirror' })

export const createMount = (config: CreateMountConfig) => {
  if (config.backend === 'relayfile-mirror') {
    return new LocalMirrorMountClient(config)
  }

  return new RelayfileCloudMountClient(config)
}
