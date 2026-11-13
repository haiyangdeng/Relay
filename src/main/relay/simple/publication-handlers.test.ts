import { expect, it, vi } from 'vitest'
import type { RelayProfilePreparation } from '../../../shared/relay/profiles'
import { createSimplePublicationHandlers } from './publication-handlers'
import { SimpleFailure } from './model'
import type { SimpleOwner } from './service'

const evidence = '11111111-1111-4111-8111-111111111111'
const report: RelayProfilePreparation = {
  evidenceId: evidence,
  name: 'Published.yaml',
  sha256: 'a'.repeat(64),
  bytes: 32,
  inspection: { structure: 'passed', active: false, coreCompatibility: 'notVerified', issues: [] }
}
function fixture() {
  let live = true
  const owner = { isCurrent: () => live },
    snapshot = {
      initialized: true,
      pending: false,
      closing: false,
      blocking: true,
      classification: 'unknown-profile' as const,
      needsRetirement: false,
      markerRevision: 'b'.repeat(64),
      operationId: evidence
    },
    result = { status: 'uncertain' as const, operationId: evidence, needsRecovery: true },
    service = {
      state: vi.fn(() => snapshot),
      prepare: vi.fn(async (_raw: unknown, _owner: SimpleOwner) => ({
        operationId: evidence,
        preparation: report
      })),
      confirm: vi.fn(async (_raw: unknown, _owner: SimpleOwner) => result),
      recover: vi.fn(async (_owner: SimpleOwner) => snapshot),
      abandon: vi.fn(async (_raw: unknown, _owner: SimpleOwner) => result)
    },
    idle = vi.fn(() => {}),
    handlers = createSimplePublicationHandlers({
      service,
      authorize: () => owner,
      assertOtherActorsIdle: idle
    })
  return {
    owner,
    snapshot,
    result,
    service,
    idle,
    handlers,
    revoke: () => {
      live = false
    }
  }
}
it('rejects every public operation before service entry after frame retirement', async () => {
  const f = fixture()
  f.revoke()
  const actual = await Promise.all([
    f.handlers.relaySimplePublicationState(),
    f.handlers.relaySimplePublicationPrepare({}),
    f.handlers.relaySimplePublicationConfirm({}),
    f.handlers.relaySimplePublicationRecover(),
    f.handlers.relaySimplePublicationAbandon({})
  ])
  expect(actual).toEqual(Array.from({ length: 5 }, () => ({ status: 'cancelled' })))
  for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled()
})
it('reads only synchronous state even when other actors are busy', async () => {
  const f = fixture()
  f.idle.mockImplementation(() => {
    throw new SimpleFailure('busy')
  })
  expect(await f.handlers.relaySimplePublicationState()).toEqual({
    status: 'ok',
    value: f.snapshot
  })
  expect(f.idle).not.toHaveBeenCalled()
  expect(await f.handlers.relaySimplePublicationPrepare({})).toEqual({ status: 'busy' })
  expect(await f.handlers.relaySimplePublicationConfirm({})).toEqual({ status: 'busy' })
  expect(await f.handlers.relaySimplePublicationRecover()).toEqual({ status: 'busy' })
  expect(await f.handlers.relaySimplePublicationAbandon({})).toEqual({ status: 'busy' })
  expect(f.service.prepare).not.toHaveBeenCalled()
  expect(f.service.recover).not.toHaveBeenCalled()
})
it('routes recovery and abandonment to the same live owner without rejecting their own unresolved state', async () => {
  const f = fixture(),
    request = { operationId: evidence, expectedMarkerRevision: 'b'.repeat(64) }
  expect(await f.handlers.relaySimplePublicationRecover()).toEqual({
    status: 'ok',
    value: f.snapshot
  })
  expect(f.service.recover).toHaveBeenCalledWith(f.owner)
  expect(await f.handlers.relaySimplePublicationAbandon(request)).toEqual({
    status: 'ok',
    value: f.result
  })
  expect(f.service.abandon).toHaveBeenCalledWith(request, f.owner)
  expect(f.idle).toHaveBeenCalledTimes(2)
})
it('forwards only public request data and returns no Main purpose token', async () => {
  const f = fixture(),
    request = { expectedRevision: 'c'.repeat(64), previewSHA256: report.sha256, name: 'Published' }
  expect(await f.handlers.relaySimplePublicationPrepare(request)).toEqual({
    status: 'ok',
    value: { operationId: evidence, preparation: report }
  })
  expect(f.service.prepare).toHaveBeenCalledWith(request, f.owner)
  await f.handlers.relaySimplePublicationConfirm({ evidenceId: evidence })
  expect(f.service.confirm).toHaveBeenCalledWith({ evidenceId: evidence }, f.owner)
})
it('suppresses a late operation result after authority is lost without claiming disk rollback', async () => {
  const f = fixture()
  f.service.confirm.mockImplementationOnce(async () => {
    f.revoke()
    return f.result
  })
  expect(await f.handlers.relaySimplePublicationConfirm({ evidenceId: evidence })).toEqual({
    status: 'cancelled'
  })
  expect(f.service.confirm).toHaveBeenCalledOnce()
})
it('preserves canonical failure codes while removing arbitrary private diagnostics', async () => {
  const f = fixture()
  f.service.prepare.mockRejectedValueOnce(new Error('https://private.invalid/?token=SECRET'))
  expect(await f.handlers.relaySimplePublicationPrepare({})).toEqual({ status: 'invalid' })
  for (const code of ['invalid', 'stale', 'cancelled', 'busy', 'closed', 'uncertain'] as const) {
    f.service.recover.mockRejectedValueOnce(new SimpleFailure(code))
    expect(await f.handlers.relaySimplePublicationRecover()).toEqual({ status: code })
  }
})
