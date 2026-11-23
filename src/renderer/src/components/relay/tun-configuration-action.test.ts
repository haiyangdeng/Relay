import { expect, it, vi } from 'vitest'
import { prepareCurrentTunConfiguration, readTunProfileId } from './tun-configuration-action'

const id = '11111111-1111-4111-8111-111111111111'
const sha256 = 'a'.repeat(64)
function fixture() {
  const current = vi.fn(() => true)
  const invoke = vi.fn(async (channel: string, _input?: unknown): Promise<unknown> => {
    if (channel === 'relayProfileList') return { profiles: [{ id, sha256 }] }
    if (channel === 'relayTunConfigurationPrepare')
      return {
        profileId: id,
        evidenceId: 'prepared',
        configurationSHA256: sha256,
        readyForParserCheck: true,
        warnings: []
      }
    if (channel === 'relayCompleteConfigurationCheck')
      return { status: 'passed', configurationSHA256: sha256, warnings: [] }
    throw Error('Unexpected network or persistence action')
  })
  return { current, invoke }
}

it('uses the selected stored profile and parser evidence without saving settings or starting TUN', async () => {
  const f = fixture()
  expect(await prepareCurrentTunConfiguration(id, f)).toBe('prepared')
  expect(f.invoke.mock.calls).toEqual([
    ['relayProfileList'],
    ['relayTunConfigurationPrepare', { intent: 'enable', profile: { id, sha256 } }],
    ['relayCompleteConfigurationCheck', { evidenceId: 'prepared' }]
  ])
})

it.each(['relayProfileList', 'relayTunConfigurationPrepare', 'relayCompleteConfigurationCheck'])(
  'rejects cancellation or changed selection during %s',
  async (boundary) => {
    const f = fixture(),
      normal = f.invoke.getMockImplementation()
    if (!normal) throw new Error('Missing fixture implementation')
    f.invoke.mockImplementation(async (channel, input) => {
      const result = await normal(channel, input)
      if (channel === boundary) f.current.mockReturnValue(false)
      return result
    })
    await expect(prepareCurrentTunConfiguration(id, f)).rejects.toThrow('当前配置已变化')
    expect(f.invoke.mock.calls.at(-1)?.[0]).toBe(boundary)
  }
)

it('does not run a parser with missing resources or accept a rejected or different configuration', async () => {
  const missing = fixture()
  missing.invoke.mockImplementation(async (channel) =>
    channel === 'relayProfileList'
      ? { profiles: [{ id, sha256 }] }
      : { profileId: id, readyForParserCheck: false, warnings: ['缺少规则资源'] }
  )
  await expect(prepareCurrentTunConfiguration(id, missing)).rejects.toThrow('缺少规则资源')
  expect(missing.invoke).toHaveBeenCalledTimes(2)
  for (const result of [
    { status: 'rejected', configurationSHA256: sha256 },
    { status: 'passed', configurationSHA256: 'b'.repeat(64) }
  ]) {
    const f = fixture(),
      normal = f.invoke.getMockImplementation()
    if (!normal) throw new Error('Missing fixture implementation')
    f.invoke.mockImplementation(async (channel, input) =>
      channel === 'relayCompleteConfigurationCheck'
        ? { ...result, warnings: [] }
        : normal(channel, input)
    )
    await expect(prepareCurrentTunConfiguration(id, f)).rejects.toThrow('检查未通过')
  }
})

it('chooses the saved profile or first imported fallback with a cold renderer, without writes', async () => {
  const items = [{ id: 'first' }, { id: 'saved' }]
  expect(
    await readTunProfileId(vi.fn().mockResolvedValue({ current: 'pending-item', items }))
  ).toBe('pending-item')
  expect(await readTunProfileId(vi.fn().mockResolvedValue({ current: 'saved', items }))).toBe(
    'saved'
  )
  const fallback = vi
    .fn()
    .mockResolvedValueOnce({ items })
    .mockResolvedValueOnce({ profiles: items })
  expect(await readTunProfileId(fallback)).toBe('first')
  await expect(
    readTunProfileId(
      vi.fn().mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ profiles: [] })
    )
  ).rejects.toThrow('请先导入')
})
