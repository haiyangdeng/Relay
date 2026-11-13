import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SMART_MODEL_CONTROLS } from '../profiles/groups'
import {
  smartCollectorSizeMiB,
  SMART_COLLECTOR_DEFAULT_MIB
} from '../../../shared/relay/smart-settings'
import { checkSmartConfiguration, stageSmartRuntimeModel } from './smart-runtime'
import { trustedCoreVariants } from './trusted-variants'
import { trustedSmartModels } from './smart-models'

const smart = trustedCoreVariants().find(
  (pin) => pin.family === 'smart' && pin.architecture === 'arm64'
)
if (!smart) throw new Error('Missing fixed Smart test pin.')
const resource = { ...smart, executable: '/not-executed' }
const configuration = (extra = {}) =>
  JSON.stringify({
    'proxy-groups': [{ name: 'S', type: 'smart' }],
    ...SMART_MODEL_CONTROLS,
    ...extra
  })
describe('Smart model runtime staging before any execution', () => {
  it('requires an exact Smart core and fixed no-update settings for Smart groups', () => {
    expect(checkSmartConfiguration(resource, configuration())).toBe(true)
    for (const pin of trustedCoreVariants().filter((pin) => pin.family !== 'smart'))
      expect(() =>
        checkSmartConfiguration({ ...pin, executable: '/not-executed' }, configuration())
      ).toThrow('可信Smart核心')
    expect(() =>
      checkSmartConfiguration({ ...resource, sha256: 'a'.repeat(64) }, configuration())
    ).toThrow()
    for (const changed of [
      { 'lgbm-auto-update': true },
      { 'lgbm-url': 'https://unexpected.invalid' }
    ])
      expect(() => checkSmartConfiguration(resource, configuration(changed))).toThrow()
  })
  it('does not read model files for the unchanged Stable runtime', async () => {
    const pin = trustedCoreVariants()[0]
    expect(
      await stageSmartRuntimeModel(
        '/unread',
        '/unwritten',
        { ...pin, executable: '/not-executed' },
        '{}'
      )
    ).toBeUndefined()
  })
  it('refuses absent, unknown and truncated model resources before creating a runtime copy', async () => {
    const root = await realpath(await mkdtemp('/private/tmp/relay-smart-stage-'))
    try {
      const receipt = join(root, 'relay-model.json'),
        destination = join(root, 'Model.bin'),
        model = trustedSmartModels()[0]
      await expect(stageSmartRuntimeModel(root, root, resource, configuration())).rejects.toThrow()
      await writeFile(
        receipt,
        JSON.stringify({ kind: 'smart', ...model, sha256: 'a'.repeat(64) }),
        { mode: 0o600 }
      )
      await expect(stageSmartRuntimeModel(root, root, resource, configuration())).rejects.toThrow(
        '可信清单'
      )
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(receipt, JSON.stringify({ kind: 'smart', ...model }), { mode: 0o600 })
      await writeFile(destination, Buffer.from('tree\ntruncated'), { mode: 0o600 })
      await expect(stageSmartRuntimeModel(root, root, resource, configuration())).rejects.toThrow(
        '已改变'
      )
      expect((await readFile(destination)).toString()).toBe('tree\ntruncated')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Smart collector trusted Core admission', () => {
  it('requires Smart family even without a Smart group', () => {
    const source = JSON.stringify({ profile: { 'smart-collector-size': 256 } })
    expect(checkSmartConfiguration(resource, source)).toBe(true)
    for (const pin of trustedCoreVariants().filter((pin) => pin.family !== 'smart'))
      expect(() =>
        checkSmartConfiguration({ ...pin, executable: '/not-executed' }, source)
      ).toThrow()
  })
  it.each([0, -1, 2.5, '100', null, 8589934592])(
    'refuses invalid explicit MiB before staging model %j',
    (size) => {
      expect(() =>
        checkSmartConfiguration(
          resource,
          configuration({ profile: { 'smart-collector-size': size } })
        )
      ).toThrow()
    }
  )
})

describe('Smart collector shared safe MiB validator', () => {
  it('keeps upstream default100 and allows positive integers above100 without clamping', () => {
    expect(SMART_COLLECTOR_DEFAULT_MIB).toBe(100)
    for (const value of [1, 100, 101, 256, 8589934591])
      expect(smartCollectorSizeMiB(value)).toBe(value)
  })
  it.each([
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    '100',
    null,
    undefined,
    false,
    {},
    8589934592,
    Number.MAX_SAFE_INTEGER
  ])('rejects invalid or unsafe exact-byte conversion %j', (value) => {
    expect(() => smartCollectorSizeMiB(value)).toThrow()
  })
})
