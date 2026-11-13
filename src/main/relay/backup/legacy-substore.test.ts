import { describe, expect, it } from 'vitest'
import { convertLegacySubStore, legacySubStoreSource } from './legacy-substore'

const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))
const current = (subs: unknown[] = [], collections: unknown[] = []) => ({
  schemaVersion: '2.0',
  subs,
  collections,
  settings: {},
  artifacts: [],
  files: [],
  modules: [],
  rules: [],
  tokens: []
})
const remote = (name = 'old') => ({
  name,
  source: 'remote',
  url: 'https://example.invalid/sub?token=private'
})
const local = (name = 'local') => ({ name, source: 'local', content: 'ss://local-definition-only' })
const decode = (value: ReturnType<typeof convertLegacySubStore>) => {
  expect(value.bytes).toBeInstanceOf(Buffer)
  if (!value.bytes) throw new Error('Missing candidate bytes')
  return JSON.parse(value.bytes.toString())
}

describe('Pure fixed Sub-Store legacy migration subset', () => {
  it('never publishes unknown top-level keys or bodies even alongside a valid subscription', () => {
    const result = convertLegacySubStore(
      bytes({
        ...current([local()]),
        'PRIVATE-tenant-secret-key': 'PRIVATE-body-secret',
        settings: { token: 'PRIVATE-token' }
      })
    )
    expect(decode(result).subs).toHaveLength(1)
    expect(JSON.stringify(result.summary)).not.toContain('PRIVATE')
    expect(result.summary.items.find((item) => item.oldName === 'settings')).toMatchObject({
      disposition: 'retained'
    })
    expect(
      result.summary.items.some((item) => item.kind === 'section' && item.oldName === undefined)
    ).toBe(true)
  })
  it('refuses numeric loss in supplied or baseline bytes while accepting equivalent decimal spellings', () => {
    const literal = (number: string) =>
      Buffer.from(
        JSON.stringify({ ...current(), unknownFutureField: 'NUMBER' }).replace('"NUMBER"', number)
      )
    const input = bytes(current([local()]))
    for (const number of ['9007199254740993', '0.1234567890123456789', '1e-999', '1e400', '-0']) {
      const baseline = literal(number),
        copy = Buffer.from(baseline)
      expect(() => convertLegacySubStore(input, baseline)).toThrow()
      expect(() => convertLegacySubStore(baseline)).toThrow()
      expect(baseline).toEqual(copy)
    }
    for (const number of ['1e2', '1.2300', '0.0001', '9.99e-20', '9007199254740992']) {
      const output = decode(convertLegacySubStore(input, literal(number)))
      expect(output.unknownFutureField).toBe(Number(number))
    }
  })
  it('uses the pinned upstream map migration, preserves display labels and remaps only accepted subscriptions', () => {
    const original = bytes({
      subs: {
        old: { name: 'old', 'display-name': '旧订阅', url: remote().url, noFlow: false },
        local: local()
      },
      collections: {
        group: {
          name: 'group',
          'display-name': '静态集合',
          subscriptions: ['old', 'local'],
          process: []
        }
      },
      settings: { secret: 'never-import' },
      artifacts: { task: { sync: true, cron: '* * * * *' } },
      modules: { script: 'throw new Error("never execute")' },
      builtin: { cache: true }
    })
    const copy = Buffer.from(original)
    const result = convertLegacySubStore(original),
      output = decode(result)
    expect(original).toEqual(copy)
    expect(legacySubStoreSource).toMatchObject({
      version: '2.44.2',
      license: 'AGPL-3.0',
      sha256: '36390c09bb34047554b83eab7cc5df36e3ee7fd72107d726ed5721abc307677a'
    })
    expect(output.schemaVersion).toBe('2.0')
    expect(output.subs).toHaveLength(2)
    expect(output.subs[0]).toMatchObject({
      displayName: '旧订阅',
      source: 'remote',
      url: remote().url,
      noFlow: true
    })
    expect(output.subs[1]).toMatchObject({
      displayName: 'local',
      source: 'local',
      content: local().content,
      noFlow: true
    })
    expect(
      output.subs.every((sub: { name: string }) =>
        /^relay-import-sub-[a-f0-9]{24}$/u.test(sub.name)
      )
    ).toBe(true)
    expect(output.collections[0]).toMatchObject({
      displayName: '静态集合',
      subscriptions: output.subs.map((sub: { name: string }) => sub.name)
    })
    expect(output.settings).toEqual({})
    for (const key of ['artifacts', 'modules', 'files', 'rules', 'tokens'])
      expect(output[key]).toEqual([])
    expect(output).not.toHaveProperty('builtin')
    expect(result.summary).toMatchObject({ schema: 'legacy-map', subscriptions: 2, collections: 1 })
    expect(result.summary.items.filter((item) => item.disposition === 'accepted')).toHaveLength(3)
    expect(JSON.stringify(result.summary)).not.toContain('private')
    expect(JSON.stringify(result.summary)).not.toContain('never-import')
    expect(result.summary.items.find((item) => item.oldName === 'modules')).toMatchObject({
      kind: 'section',
      disposition: 'retained'
    })
  })
  it('accepts bounded Base64 canonical arrays, keeps displayName and disables automatic flow requests', () => {
    const input = {
      ...current([{ ...remote(), displayName: '名称保留', noFlow: false }]),
      root: { token: 'old' }
    }
    const result = convertLegacySubStore(Buffer.from(bytes(input).toString('base64')))
    const output = decode(result)
    expect(output.subs[0]).toMatchObject({ displayName: '名称保留', noFlow: true })
    expect(output.subs[0]).not.toHaveProperty('process')
    expect(output).not.toHaveProperty('root')
    expect(result.summary.schema).toBe('2.0')
  })
  it('preserves every unrelated baseline field and existing behavior while importing no old tasks or credentials', () => {
    const base = {
      ...current([
        { ...remote('existing'), process: [{ type: 'existing script' }], noFlow: false }
      ]),
      settings: { secret: 'current-secret', auto: true },
      tokens: [{ name: 'current-token', token: 'keep' }],
      artifacts: [{ sync: true, cron: '* * * * *', source: 'existing' }],
      files: [{ name: 'current file' }],
      modules: [{ script: 'existing script' }],
      rules: [{ active: true }],
      unknownFutureField: { deeply: ['unchanged', { value: false }] },
      builtin: { currentCache: true }
    }
    const before = bytes(base),
      input = bytes({
        ...current([local()]),
        settings: { token: 'old-secret' },
        artifacts: [{ sync: true, cron: '* * * * *' }]
      })
    const result = convertLegacySubStore(input, before),
      output = decode(result)
    expect(before).toEqual(bytes(base))
    for (const key of Object.keys(base).filter((key) => !['subs', 'collections'].includes(key)))
      expect(output[key]).toEqual(base[key as keyof typeof base])
    expect(output.subs[0]).toEqual(base.subs[0])
    expect(output.subs).toHaveLength(2)
    expect(JSON.stringify(output)).not.toContain('old-secret')
  })
  it.each([
    { process: [{ type: 'Script Operator', args: { content: 'throw new Error()' } }] },
    { process: [{ type: 'Keyword Filter' }] },
    { process: null },
    { process: {} },
    { proxy: 'http://proxy.invalid' },
    { headers: { Authorization: 'secret' } },
    { mergeSources: 'remoteFirst' },
    { unknownBehavior: false }
  ])('retains a whole subscription with behavior %j instead of stripping it', (extra) => {
    const result = convertLegacySubStore(bytes(current([{ ...remote(), ...extra }])))
    expect(result.bytes).toBeUndefined()
    expect(result.summary.items[0]).toMatchObject({ disposition: 'retained', oldName: 'old' })
    expect(result.summary.subscriptions).toBe(0)
  })
  it('retains malformed and fragmented sources individually while keeping another basic record', () => {
    const input = current([
      { ...remote('fragment'), url: 'https://example.invalid/file#script=evil' },
      { ...remote('multi'), url: 'https://a.invalid\nhttps://b.invalid' },
      { ...remote('scheme'), url: 'file:///private/secret' },
      { ...remote('mixed'), content: 'fallback' },
      { ...local('mixed-local'), url: 'https://fallback.invalid' },
      { ...remote('badflag'), noFlow: 'false' },
      { ...remote('labels'), displayName: 'A', 'display-name': 'B' },
      local('accepted')
    ])
    const result = convertLegacySubStore(bytes(input)),
      output = decode(result)
    expect(output.subs).toHaveLength(1)
    expect(output.subs[0].displayName).toBe('accepted')
    expect(result.summary.items.filter((item) => item.disposition === 'retained')).toHaveLength(13)
  })
  it('never adopts baseline subscriptions for collections and retains tag/process/unknown dependencies', () => {
    const source = current(
      [local()],
      [
        { name: 'missing', subscriptions: ['baseline'] },
        { name: 'tagged', subscriptions: ['local'], subscriptionTags: ['tag'] },
        { name: 'processed', subscriptions: ['local'], process: [{ type: 'Flag Operator' }] },
        { name: 'ua', subscriptions: ['local'], ua: 'special' },
        { name: 'duplicates', subscriptions: ['local', 'local'] },
        { name: 'valid', subscriptions: ['local'] }
      ]
    )
    const result = convertLegacySubStore(bytes(source), bytes(current([remote('baseline')]))),
      output = decode(result)
    expect(output.collections).toHaveLength(1)
    expect(output.collections[0].displayName).toBe('valid')
    expect(output.collections[0].subscriptions).toEqual([output.subs[1].name])
    expect(result.summary.collections).toBe(1)
  })
  it('rejects ambiguous duplicate old identities rather than binding a collection to the first one', () => {
    const result = convertLegacySubStore(
      bytes(current([local('same'), remote('same')], [{ name: 'group', subscriptions: ['same'] }]))
    )
    expect(result.bytes).toBeUndefined()
    expect(
      result.summary.items
        .filter((item) => item.kind !== 'section')
        .every((item) => item.disposition === 'retained')
    ).toBe(true)
  })
  it('uses a new unique technical name without overwriting a previous import or truncating the display label', () => {
    const original = bytes(current([{ ...local('旧名字'), displayName: '长'.repeat(128) }]))
    const first = convertLegacySubStore(original),
      firstOutput = decode(first)
    const second = convertLegacySubStore(original, first.bytes),
      secondOutput = decode(second)
    expect(secondOutput.subs[0]).toEqual(firstOutput.subs[0])
    expect(secondOutput.subs[1].name).not.toBe(secondOutput.subs[0].name)
    expect(secondOutput.subs[1].displayName).toBe('长'.repeat(128))
    const tooLong = convertLegacySubStore(bytes(current([local('x'.repeat(129))])))
    expect(tooLong.bytes).toBeUndefined()
  })
  it('retains entire excess records and collections when the existing category is full', () => {
    const base = current(Array.from({ length: 199 }, (_, index) => local('base' + index)))
    const source = current(
      [local('one'), local('two')],
      [{ name: 'both', subscriptions: ['one', 'two'] }]
    )
    const result = convertLegacySubStore(bytes(source), bytes(base)),
      output = decode(result)
    expect(output.subs).toHaveLength(200)
    expect(output.subs.slice(0, 199)).toEqual(base.subs)
    expect(output.collections).toEqual([])
    expect(result.summary).toMatchObject({ subscriptions: 1, collections: 0 })
  })
  it('checks the actual serialized candidate budget without dropping unrelated baseline data', () => {
    const base = { ...current(), keep: 'x'.repeat(2 * 1024 * 1024 - 300) }
    expect(bytes(base).length).toBeLessThan(2 * 1024 * 1024)
    const result = convertLegacySubStore(bytes(current([local()])), bytes(base))
    expect(result.bytes).toBeUndefined()
    expect(result.summary.items[0].reason).toContain('2MiB')
  })
  it.each(['3.0', 2, null, false, ''])(
    'rejects unsupported schemaVersion %j without relabeling it',
    (schemaVersion) => {
      expect(() => convertLegacySubStore(bytes({ ...current([local()]), schemaVersion }))).toThrow(
        'schema'
      )
    }
  )
  it('accepts only old maps or canonical arrays, refuses invalid baseline layouts and preserves original bytes', () => {
    for (const input of [
      { subs: [] },
      { schemaVersion: '2.0', subs: {}, collections: [] },
      current(Array.from({ length: 201 }, (_, index) => local('sub' + index)))
    ])
      expect(() => convertLegacySubStore(bytes(input))).toThrow()
    const original = bytes(current([local()]))
    for (const base of [
      { subs: {}, collections: {} },
      { ...current(), schemaVersion: '3.0' },
      { ...current(), artifacts: {} },
      current([local('duplicate'), local('duplicate')])
    ])
      expect(() => convertLegacySubStore(original, bytes(base))).toThrow()
  })
  it('rejects malformed UTF8/Base64, nonobjects and oversized data without interpreting any code', () => {
    for (const original of [
      Buffer.from([0xff]),
      Buffer.from('not a json'),
      bytes([]),
      Buffer.alloc(2 * 1024 * 1024 + 1),
      Buffer.from('e30===')
    ])
      expect(() => convertLegacySubStore(original)).toThrow()
    const result = convertLegacySubStore(bytes(current([], [])))
    expect(result.bytes).toBeUndefined()
  })
})
