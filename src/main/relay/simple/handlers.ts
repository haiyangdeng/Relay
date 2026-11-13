import type { createProfileService } from '../profiles/service'
import type { RelaySimpleIpcApi, RelaySimpleReply } from '../../../shared/relay/simple'
import type { RelaySimpleSourcesIpcApi } from '../../../shared/relay/simple-sources'
import type { RelaySimpleConfigurationIpcApi } from '../../../shared/relay/simple-configuration'
import type { createSimpleDraftService, SimpleOwner } from './service'
import { SimpleFailure } from './model'

export async function reopenSimpleWhenIdle(
  service: Pick<ReturnType<typeof createSimpleDraftService>, 'whenIdle' | 'state' | 'reopen'>,
  isCurrent: () => boolean
): Promise<void> {
  await service.whenIdle()
  // Even an idle fast-path quit must retire every old generated capability.
  if (isCurrent()) service.reopen()
}

// Main supplies one trusted visible frame + renderer epoch per invocation.
// Neither raw source capabilities nor YAML previews cross this facade.
export function createSimpleHandlers(adapters: {
  service: Pick<
    ReturnType<typeof createSimpleDraftService>,
    | 'readEditableDraft'
    | 'saveModule'
    | 'preview'
    | 'prepareProfile'
    | 'recover'
    | 'readSourceBindings'
    | 'saveSourceBinding'
    | 'readConfigurationBinding'
    | 'saveConfigurationBinding'
  >
  profiles: Pick<ReturnType<typeof createProfileService>, 'prepareGenerated'>
  authorize(): SimpleOwner
  assertIdle(): void
}) {
  const assertOwner = (owner: SimpleOwner): void => {
    let live = false
    try {
      live = owner.isCurrent()
    } catch {
      /* Revoked frame. */
    }
    if (!live) throw new SimpleFailure('cancelled')
  }
  const run = async <T>(
    action: (owner: SimpleOwner) => Promise<T>
  ): Promise<RelaySimpleReply<T>> => {
    try {
      const owner = adapters.authorize()
      assertOwner(owner)
      adapters.assertIdle()
      const value = await action(owner)
      assertOwner(owner)
      return { status: 'ok', value }
    } catch (error) {
      return { status: error instanceof SimpleFailure ? error.code : 'invalid' }
    }
  }
  return {
    relaySimpleReadEditableDraft: () => run((owner) => adapters.service.readEditableDraft(owner)),
    relaySimpleSaveModule: (request: unknown) =>
      run((owner) => adapters.service.saveModule(request, owner)),
    relaySimplePreview: (revision: unknown) =>
      run((owner) => adapters.service.preview(revision, owner)),
    relaySimplePrepareProfile: (request: unknown) =>
      run(async (owner) => {
        const source = await adapters.service.prepareProfile(request, owner)
        assertOwner(owner)
        // The service has settled. Recheck the global gate before ProfileService
        // takes ownership of the capability and its confirmation proof.
        adapters.assertIdle()
        return adapters.profiles.prepareGenerated(source)
      }),
    relaySimpleRecover: () => run((owner) => adapters.service.recover(owner)),
    relaySimpleReadSourceBindings: () => run((owner) => adapters.service.readSourceBindings(owner)),
    relaySimpleSaveSourceBinding: (request: unknown) =>
      run((owner) => adapters.service.saveSourceBinding(request, owner)),
    relaySimpleReadConfigurationBinding: () =>
      run((owner) => adapters.service.readConfigurationBinding(owner)),
    relaySimpleSaveConfigurationBinding: (request: unknown) =>
      run((owner) => adapters.service.saveConfigurationBinding(request, owner))
  } satisfies RelaySimpleIpcApi & RelaySimpleSourcesIpcApi & RelaySimpleConfigurationIpcApi
}
