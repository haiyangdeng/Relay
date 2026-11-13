import { describe, expect, it, vi } from 'vitest'
import { validateCodePrepared, validateCodeApplied } from '../../shared/relay/protocol'
import { createCodeService } from './code'
import { codeFixture, appliedCodeFixture } from './__fixtures__/code'
import { preferenceFixture } from './__fixtures__/preferences'

describe('Code preparation and explicit joint transaction', () => {
  const input = preferenceFixture().preferences
  const prepared = (report = codeFixture()) => ({ report, context: undefined })
  it('cancels without writing, then applies exactly one main-owned proof', async () => {
    const confirm = vi.fn(async () => false),
      apply = vi.fn(async () => appliedCodeFixture())
    const service = createCodeService({ prepare: async () => prepared(), confirm, apply })
    const proof = await service.prepare(input)
    expect((await service.apply({ evidenceId: proof.evidenceId })).status).toBe('cancelled')
    expect(apply).not.toHaveBeenCalled()
    confirm.mockResolvedValue(true)
    expect((await service.apply({ evidenceId: proof.evidenceId })).status).toBe('applied')
    expect(apply).toHaveBeenCalledWith(input, proof.revision)
    await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow('重新读取')
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it('refuses renderer paths, JSON drafts, forged and expired proofs', async () => {
    let now = 1000
    const confirm = vi.fn(async () => true),
      apply = vi.fn(async () => appliedCodeFixture())
    const service = createCodeService({
      prepare: async () => prepared(),
      confirm,
      apply,
      now: () => now
    })
    for (const raw of [
      { ...input, context: { home: '/injected' } },
      { ...input, existingJSON: 'private' }
    ])
      await expect(service.prepare(raw)).rejects.toThrow()
    const proof = await service.prepare(input)
    for (const raw of [
      { evidenceId: 'a'.repeat(36) },
      { evidenceId: proof.evidenceId, revision: proof.revision },
      { evidenceId: proof.evidenceId, settings: input }
    ])
      await expect(service.apply(raw)).rejects.toThrow()
    now += 60001
    await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow()
    expect(confirm).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })
  it.each([60001, -1])(
    'rejects a proof with invalid age %i ms after native confirmation',
    async (age) => {
      let now = 1000
      const apply = vi.fn(async () => appliedCodeFixture())
      const service = createCodeService({
        prepare: async () => prepared(),
        confirm: async () => {
          now += age
          return true
        },
        apply,
        now: () => now
      })
      const proof = await service.prepare(input)
      await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow('确认已过期')
      expect(service.isApplying()).toBe(false)
      expect(apply).not.toHaveBeenCalled()
      now = 1000
      await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow('重新读取')
    }
  )
  it.each([
    ['expired', '确认已过期'],
    ['revoked', '准备结果已改变'],
    ['listener-lost', 'listener lost']
  ])('does not write after the final listener check is %s', async (scenario, message) => {
    let now = 1000
    let started!: () => void
    let finish!: () => void
    const verificationStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const readback = new Promise<void>((resolve, reject) => {
      finish = () => (scenario === 'listener-lost' ? reject(new Error('listener lost')) : resolve())
    })
    const apply = vi.fn(async () => appliedCodeFixture())
    const service = createCodeService({
      prepare: async () => prepared(),
      confirm: async () => true,
      verify: () => {
        started()
        return readback
      },
      apply,
      now: () => now
    })
    const proof = await service.prepare(input)
    const result = expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow(message)
    await verificationStarted
    if (scenario === 'expired') now += 60001
    if (scenario === 'revoked') service.clear()
    finish()
    await result
    expect(apply).not.toHaveBeenCalled()
    expect(service.isApplying()).toBe(false)
    now = 1000
    await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow('重新读取')
  })
  it('keeps the selected owned listener association when an older preparation completes late', async () => {
    const context = { instance: 'owned-listener' }
    let finishOld!: (value: ReturnType<typeof prepared>) => void
    const oldPreparation = new Promise<ReturnType<typeof prepared>>((resolve) => {
      finishOld = resolve
    })
    const apply = vi.fn(async () => appliedCodeFixture())
    const confirm = vi.fn(async () => true)
    const verify = vi.fn(async () => undefined)
    const prepare = vi
      .fn<
        () => Promise<{
          report: ReturnType<typeof codeFixture>
          context: typeof context | undefined
        }>
      >()
      .mockImplementationOnce(() => oldPreparation)
      .mockResolvedValue({ report: codeFixture(), context })
    const service = createCodeService({
      prepare,
      confirm,
      verify,
      apply
    })
    const old = expect(service.prepare(input)).rejects.toThrow('过期')
    const selected = await service.prepare(input)
    finishOld(prepared())
    await old
    expect(selected).not.toHaveProperty('context')
    expect(await service.apply({ evidenceId: selected.evidenceId })).toMatchObject({
      status: 'applied'
    })
    expect(confirm).toHaveBeenCalledWith(selected)
    expect(verify).toHaveBeenCalledWith(input, context)
    expect(apply).toHaveBeenCalledWith(input, selected.revision)
  })
  it('blocks not-ready or already-matching files before confirmation', async () => {
    for (const report of [
      { ...codeFixture(), helperReady: false, canApply: false },
      { ...codeFixture(), browserState: 'running' as const, canApply: false },
      { ...codeFixture(), changedTargets: [], canApply: false }
    ]) {
      const confirm = vi.fn(async () => true)
      const service = createCodeService({
        prepare: async () => prepared(report),
        confirm,
        apply: async () => appliedCodeFixture()
      })
      const proof = await service.prepare(input)
      await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow()
      expect(confirm).not.toHaveBeenCalled()
    }
  })
  it('waits for the transaction, rejects duplicate confirmation, and does not reuse uncertain results', async () => {
    let finish!: (answer: boolean) => void
    const apply = vi.fn(async () => {
      throw new Error('reply lost')
    })
    const service = createCodeService({
      prepare: async () => prepared(),
      confirm: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      apply
    })
    const proof = await service.prepare(input)
    const result = service.apply({ evidenceId: proof.evidenceId })
    await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow('进行中')
    await expect(service.prepare(input)).rejects.toThrow('尚未结束')
    let idle = false
    const waiting = service.whenIdle().then(() => {
      idle = true
    })
    expect(idle).toBe(false)
    expect(service.isApplying()).toBe(true)
    finish(true)
    expect((await result).status).toBe('uncertain')
    await waiting
    expect(idle).toBe(true)
    expect(service.isApplying()).toBe(false)
    await expect(service.apply({ evidenceId: proof.evidenceId })).rejects.toThrow()
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it('discards late preparations and a proof invalidated during confirmation', async () => {
    let finish!: (report: ReturnType<typeof prepared>) => void
    const service = createCodeService({
      prepare: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      confirm: async () => true,
      apply: async () => appliedCodeFixture()
    })
    const result = service.prepare(input),
      rejected = expect(result).rejects.toThrow('过期')
    service.clear()
    finish(prepared())
    await rejected
    const apply = vi.fn(async () => appliedCodeFixture())
    const second = createCodeService({
      prepare: async () => prepared(),
      confirm: async () => {
        second.clear()
        return true
      },
      apply
    })
    const proof = await second.prepare(input)
    await expect(second.apply({ evidenceId: proof.evidenceId })).rejects.toThrow('改变')
    expect(apply).not.toHaveBeenCalled()
  })
  it('rejects contradictory native reports and wrong committed parameters', async () => {
    for (const report of [
      { ...codeFixture(), browserState: 'running' },
      { ...codeFixture(), changedTargets: ['claudeSettings', 'claudeSettings'] },
      { ...codeFixture(), revision: 'wrong' },
      { ...codeFixture(), changedTargets: ['outside'] }
    ])
      expect(() => validateCodePrepared(report)).toThrow()
    expect(() => validateCodeApplied({ ...appliedCodeFixture(), backupId: '../escape' })).toThrow()
    const wrong = appliedCodeFixture()
    wrong.preferenceSnapshot.preferences.httpPort = 9999
    const service = createCodeService({
      prepare: async () => prepared(),
      confirm: async () => true,
      apply: async () => wrong
    })
    const proof = await service.prepare(input)
    expect((await service.apply({ evidenceId: proof.evidenceId })).status).toBe('uncertain')
  })
})
