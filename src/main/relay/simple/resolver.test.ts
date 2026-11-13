import { describe, expect, it, vi } from 'vitest'
import { defaultSimpleDraft, type SimpleSource } from '../../../shared/simple-config'
import { compileSimpleConfig } from '../../simple/compiler'
import { hash, SimpleFailure } from './model'
import { compileSnapshot, publicPreview, resolveSnapshot, snapshotInputs } from './resolver'

const node = { name: 'B', type: 'http', server: '192.0.2.1', port: 8080 }
const chain = [{ ...node, name: 'A', 'dialer-proxy': 'B' }, node]
function fixture(mode: SimpleSource['mode'], body = JSON.stringify({ proxies: chain })) {
  const selection = { id: '11111111-1111-4111-8111-111111111111', sha256: hash(body) }
  const source = {
    id: '22222222-2222-4222-8222-222222222222',
    revision: 'c'.repeat(64),
    profile: selection,
    url: 'https://source.invalid/list.yaml'
  }
  const draft = defaultSimpleDraft()
  draft.sources = [
    {
      id: 'bound',
      name: 'Bound',
      mode,
      prefix: '',
      interval: 3600,
      proxies: [],
      profileId: selection.id
    }
  ]
  const bindings = [
    {
      id: 'bound',
      profile: selection,
      profileRevision: 'b'.repeat(64),
      ...(mode === 'http' ? { source: { id: source.id, revision: source.revision } } : {})
    }
  ]
  const inputs = snapshotInputs({
    configuration: { revision: '', shared: {} },
    profiles: [
      {
        bindingId: 'bound',
        profile: { selection, revision: 'b'.repeat(64), text: body },
        ...(mode === 'http' ? { source } : {})
      }
    ],
    recheck: async () => {}
  })
  return { draft, bindings, inputs }
}
function fixedCompiler(f: ReturnType<typeof fixture>) {
  const resolved = resolveSnapshot(f.draft, f.bindings, '', f.inputs)
  return compileSimpleConfig(resolved.draft, resolved.shared)
}
const emptyInputs = () =>
  snapshotInputs({
    configuration: { revision: '', shared: {} },
    profiles: [],
    recheck: async () => {}
  })

describe('Pinned Simple resolver and fixed compiler preflight', () => {
  it('rejects inline payload own-name dialers even when an unrelated global node has the same name', () => {
    const f = fixture('inline')
    f.draft.modules.proxies = JSON.stringify([node])
    expect(fixedCompiler(f).errors).toEqual([])
    expect(() => compileSnapshot(f.draft, f.bindings, '', f.inputs)).toThrow(SimpleFailure)
  })
  it.each(['extract', 'http'] as const)(
    'keeps %s as an unchanged fixed-compiler control',
    (mode) => {
      const f = fixture(mode)
      const result = compileSnapshot(f.draft, f.bindings, '', f.inputs)
      expect(result).toEqual(fixedCompiler(f))
      expect(result.errors).toEqual([])
      if (mode === 'http') {
        expect(result.yaml).toContain('https://source.invalid/list.yaml')
        expect(result.references.outbounds).not.toContain('A')
      }
    }
  )
  it.each([5, false, {}, []])(
    'does not weakly decode nonstring inline dialer %j into an outbound name',
    (target) => {
      const f = fixture(
        'inline',
        JSON.stringify({
          proxies: [
            { ...node, name: '5' },
            { ...node, 'dialer-proxy': target }
          ]
        })
      )
      if (target === 5) expect(fixedCompiler(f).errors).toEqual([])
      expect(() => compileSnapshot(f.draft, f.bindings, '', f.inputs)).toThrow('invalid')
    }
  )
  it.each(['dialer_proxy', 'DIALER-PROXY', 'DiAlEr_PrOxY'])(
    'checks manual inline alias %s against actual global declarations',
    (field) => {
      const draft = defaultSimpleDraft(),
        inputs = emptyInputs()
      draft.modules['proxy-providers'] = JSON.stringify({
        Manual: { type: 'inline', payload: [{ ...node, [field]: 'MissingGlobal' }] }
      })
      expect(compileSimpleConfig(draft).errors).toEqual([])
      expect(() => compileSnapshot(draft, [], '', inputs)).toThrow('invalid')
      draft.modules.proxies = JSON.stringify([{ ...node, name: 'MissingGlobal' }])
      expect(compileSnapshot(draft, [], '', inputs)).toEqual(compileSimpleConfig(draft))
    }
  )
  it('keeps an explicit external builtin and Core-unset null target byte identical to the fixed compiler', () => {
    for (const target of ['DIRECT', null]) {
      const draft = defaultSimpleDraft(),
        inputs = emptyInputs()
      draft.modules['proxy-providers'] = JSON.stringify({
        Manual: { type: 'inline', payload: [{ ...node, 'dialer-proxy': target }] }
      })
      expect(compileSnapshot(draft, [], '', inputs)).toEqual(compileSimpleConfig(draft))
    }
  })
  it('accepts provider-only HTTP structure without extracting cached nodes, while extract/inline still require nonempty nodes', () => {
    const body =
      'proxy-providers:\n  Remote:\n    type: http\n    url: https://nested.invalid/list.yaml\n'
    const http = fixture('http', body)
    expect(
      resolveSnapshot(http.draft, http.bindings, '', http.inputs).draft.sources[0].proxies
    ).toEqual([])
    expect(compileSnapshot(http.draft, http.bindings, '', http.inputs)).toEqual(fixedCompiler(http))
    for (const mode of ['inline', 'extract'] as const) {
      const f = fixture(mode, body)
      expect(() => resolveSnapshot(f.draft, f.bindings, '', f.inputs)).toThrow('invalid')
    }
  })
  it('does not relax profile/source identity or URL checks for HTTP mode', () => {
    const f = fixture('http', '{}'),
      changed = structuredClone(f.inputs)
    changed.profiles[0].profile.text += '# changed\n'
    expect(() => compileSnapshot(f.draft, f.bindings, '', changed)).toThrow('stale')
    const unsafe = structuredClone(f.inputs),
      captured = unsafe.profiles[0].source
    if (!captured) throw new Error('Missing captured HTTP source')
    captured.url = 'file:///never-read'
    expect(() => compileSnapshot(f.draft, f.bindings, '', unsafe)).toThrow('invalid')
  })
  it('rejects warning-bearing module YAML with an empty generic preview and no process warning', () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {}),
      credential = 'portable-module-warning-secret',
      draft = defaultSimpleDraft()
    try {
      draft.modules.general = `!FixtureUnknown {mode: rule, password: ${credential}}\n`
      const preview = publicPreview(compileSnapshot(draft, [], '', emptyInputs()))
      expect(preview).toEqual({
        yamlSHA256: hash(''),
        bytes: 0,
        errors: ['Simple configuration is invalid; inspect the private draft.'],
        valid: false
      })
      expect(JSON.stringify(preview)).not.toContain(credential)
      expect(JSON.stringify(preview)).not.toContain('FixtureUnknown')
      expect(warning).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
  it('rejects warning-bearing captured source YAML as a generic invalid failure without logging its credential', () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {}),
      credential = 'portable-source-warning-secret',
      f = fixture(
        'extract',
        `proxies:\n  - name: A\n    type: http\n    server: 192.0.2.1\n    port: 8080\n    password: !FixtureUnknown ${credential}\n`
      )
    try {
      let failure: unknown
      try {
        compileSnapshot(f.draft, f.bindings, '', f.inputs)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(SimpleFailure)
      expect(failure).toMatchObject({
        code: 'invalid',
        message: 'Simple draft operation invalid'
      })
      expect(JSON.stringify(failure)).not.toContain(credential)
      expect(String(failure)).not.toContain(credential)
      expect(String(failure)).not.toContain('FixtureUnknown')
      expect(warning).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
  it('projects invalid parser output to metadata without returning YAML or a credential-bearing source line', () => {
    const draft = defaultSimpleDraft()
    draft.modules.proxies = '- private-parser-secret: [\n'
    const result = publicPreview(compileSnapshot(draft, [], '', emptyInputs()))
    expect(result.valid).toBe(false)
    expect(Object.keys(result).sort()).toEqual(['bytes', 'errors', 'valid', 'yamlSHA256'])
    expect(JSON.stringify(result)).not.toContain('private-parser-secret')
  })
})
