import type { RelaySimplePublicationIpcApi } from '../../../shared/relay/simple-publication'
import type { RelaySimpleReply } from '../../../shared/relay/simple'
import type { createSimplePublicationService } from './publication-service'
import type { SimpleOwner } from './service'
import { SimpleFailure } from './model'

export function createSimplePublicationHandlers(adapters: {
  service: Pick<
    ReturnType<typeof createSimplePublicationService>,
    'state' | 'prepare' | 'confirm' | 'recover' | 'abandon'
  >
  authorize(): SimpleOwner
  // This Main-owned gate excludes this publication's unresolved marker only.
  // Every other configuration, source, backup and runtime actor remains gated.
  assertOtherActorsIdle(): void
}) {
  const current = (owner: SimpleOwner): void => {
    let live = false
    try {
      live = owner.isCurrent()
    } catch {
      /* Retired frame. */
    }
    if (!live) throw new SimpleFailure('cancelled')
  }
  const run = async <T>(
    action: (owner: SimpleOwner) => Promise<T> | T,
    readState = false
  ): Promise<RelaySimpleReply<T>> => {
    try {
      const owner = adapters.authorize()
      current(owner)
      // State is a synchronous no-body metadata projection. It can describe
      // initialization, an active operation or unresolved intent without writes.
      if (!readState) adapters.assertOtherActorsIdle()
      const value = await action(owner)
      current(owner)
      return { status: 'ok', value }
    } catch (error) {
      return { status: error instanceof SimpleFailure ? error.code : 'invalid' }
    }
  }
  return {
    relaySimplePublicationState: () => run(() => adapters.service.state(), true),
    relaySimplePublicationPrepare: (request: unknown) =>
      run((owner) => adapters.service.prepare(request, owner)),
    relaySimplePublicationConfirm: (request: unknown) =>
      run((owner) => adapters.service.confirm(request, owner)),
    relaySimplePublicationRecover: () => run((owner) => adapters.service.recover(owner)),
    relaySimplePublicationAbandon: (request: unknown) =>
      run((owner) => adapters.service.abandon(request, owner))
  } satisfies RelaySimplePublicationIpcApi
}
