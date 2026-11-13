import { describe, expect, it } from 'vitest'
import { backupDirectories } from './archive'
import {
  legacyRecoveryJournal,
  recoveryJournal,
  recoveryRoots,
  type RecoveryAction,
  type RecoveryAsset,
  type RecoveryIntent,
  type RecoveryJournal,
  type RecoverySlot
} from './recovery-journal'

const directories = new Set<string>(backupDirectories)
const fingerprint = (value: string): string => value.repeat(64)
function fixture(): RecoveryJournal {
  return {
    version: 2,
    plan: {
      id: '11111111-1111-4111-8111-111111111111',
      baselineSHA256: fingerprint('a'),
      targetSHA256: fingerprint('b'),
      archiveSHA256: fingerprint('c'),
      files: 10,
      replacedFiles: 2,
      removedFiles: 1,
      containsSecrets: true,
      preparedAt: 1800000000000
    },
    baselineArchiveSHA256: fingerprint('d'),
    directoryIdentity: { dev: 1, ino: 100, uid: 501, mode: 0o40700 },
    phase: 'staged',
    direction: 'resume',
    roots: recoveryRoots.map((root, index) => ({
      root,
      before: {
        sha256: fingerprint('e'),
        identity: {
          dev: 1,
          ino: 1000 + index * 2,
          uid: 501,
          mode: directories.has(root) ? 0o40755 : 0o100644
        }
      },
      after: {
        sha256: fingerprint('f'),
        identity: {
          dev: 1,
          ino: 1001 + index * 2,
          uid: 501,
          mode: directories.has(root) ? 0o40700 : 0o100600
        }
      },
      baseline: 'current',
      target: 'candidate'
    })),
    completed: []
  }
}
function asset(value: RecoveryAsset | null): RecoveryAsset {
  if (!value) throw new Error('Fixture asset missing')
  return value
}
function withRoot(patch: Record<string, unknown>): unknown {
  const journal = fixture()
  return {
    ...journal,
    roots: journal.roots.map((root, index) => (index === 0 ? { ...root, ...patch } : root))
  }
}
function intentFixture(
  action: RecoveryAction,
  from: RecoverySlot,
  to: RecoverySlot
): RecoveryJournal {
  const journal = fixture(),
    root = journal.roots[0]
  journal.direction = action
  journal.phase = action === 'resume' ? 'applying' : 'rolling-back'
  if (from === 'candidate') root.baseline = 'original'
  if (action === 'rollback') {
    root.baseline = 'original'
    root.target = from === 'current' ? 'current' : 'displaced'
  }
  const source = asset(
    (action === 'resume' && from === 'current') || from === 'original' ? root.before : root.after
  )
  journal.intent = {
    action,
    root: root.root,
    from,
    to,
    identity: { ...source.identity },
    sha256: source.sha256
  }
  return journal
}

describe('Pure v2 restore journal validation', () => {
  it('retains safe existing baseline modes and returns a detached fixed-root document', () => {
    const journal = fixture(),
      parsed = recoveryJournal(journal)
    expect(parsed).toEqual(journal)
    expect(parsed.roots.map((root) => root.root)).toEqual(recoveryRoots)
    parsed.plan.id = '22222222-2222-4222-8222-222222222222'
    asset(parsed.roots[0].before).identity.ino++
    parsed.completed.push(recoveryRoots[0])
    expect(journal.plan.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(asset(journal.roots[0].before).identity.ino).toBe(1000)
    expect(journal.completed).toEqual([])
  })
  it.each([
    ['resume', 'current', 'original'],
    ['resume', 'candidate', 'current'],
    ['rollback', 'current', 'displaced'],
    ['rollback', 'original', 'current']
  ] as const)(
    'accepts only the complete %s %s → %s intent bound to its role',
    (action, from, to) => {
      const journal = intentFixture(action, from, to)
      expect(recoveryJournal(journal)).toEqual(journal)
    }
  )
  it('distinguishes absent baseline/target roles without substituting a missing root', () => {
    const journal = fixture()
    journal.roots[0].before = null
    journal.roots[0].baseline = null
    journal.roots[1].after = null
    journal.roots[1].target = null
    expect(recoveryJournal(journal)).toEqual(journal)
    for (const patch of [
      { before: null },
      { after: null },
      { baseline: null },
      { target: null },
      { baseline: 'candidate' },
      { target: 'original' },
      { baseline: 'current', target: 'current' },
      { target: 'displaced' }
    ])
      expect(() => recoveryJournal(withRoot(patch))).toThrow('恢复记录')
  })
  it('rejects legacy, unknown and unbounded records instead of upgrading or coercing them', () => {
    const journal = fixture()
    for (const value of [
      null,
      [],
      { ...journal, version: 1 },
      { ...journal, version: 3 },
      { ...journal, version: '2' },
      { ...journal, path: '/outside' },
      { ...journal, phase: ['staged'] },
      { ...journal, phase: { toString: () => 'staged' } },
      { ...journal, direction: { toString: () => 'resume' } },
      { ...journal, roots: [] },
      { ...journal, roots: [...journal.roots, journal.roots[0]] },
      { ...journal, baselineArchiveSHA256: 'D'.repeat(64) },
      { ...journal, intent: undefined },
      { ...journal, marker: undefined }
    ])
      expect(() => recoveryJournal(value)).toThrow('恢复记录')
  })
  it('rejects reordered, duplicate, foreign and traversal roots and unknown nested fields', () => {
    const journal = fixture()
    for (const roots of [
      [...journal.roots].reverse(),
      journal.roots.map((root, index) => (index === 1 ? journal.roots[0] : root)),
      journal.roots.map((root, index) => (index === 0 ? { ...root, root: '../outside' } : root)),
      journal.roots.map((root, index) => (index === 0 ? { ...root, sourcePath: '/outside' } : root))
    ])
      expect(() => recoveryJournal({ ...journal, roots })).toThrow('恢复记录')
    expect(() =>
      recoveryJournal(withRoot({ before: { ...asset(journal.roots[0].before), bytes: 'secret' } }))
    ).toThrow('恢复记录')
    expect(() => recoveryJournal({ ...journal, completed: ['Configuration'] })).toThrow('恢复记录')
  })
  it('bounds exact persisted plan fields, counters, identifiers, hashes and preparation time', () => {
    const journal = fixture()
    for (const patch of [
      { id: 'not-an-id' },
      { sourcePath: '/outside' },
      { baselineSHA256: 'a' },
      { targetSHA256: 1 },
      { archiveSHA256: 'A'.repeat(64) },
      { files: -1 },
      { files: 2001 },
      { replacedFiles: 11 },
      { removedFiles: 2001 },
      { containsSecrets: false },
      { preparedAt: Number.POSITIVE_INFINITY },
      { preparedAt: -1 },
      { preparedAt: 1.5 },
      { preparedAt: Number.MAX_SAFE_INTEGER }
    ])
      expect(() => recoveryJournal({ ...journal, plan: { ...journal.plan, ...patch } })).toThrow(
        '恢复记录'
      )
  })
  it('requires safe real stat identities with the correct fixed-root file type', () => {
    const journal = fixture(),
      before = asset(journal.roots[0].before)
    for (const patch of [
      { dev: '1' },
      { ino: 0 },
      { ino: Number.MAX_SAFE_INTEGER + 1 },
      { uid: -1 },
      { mode: 0o700 },
      { mode: 0o100600 },
      { mode: 0o40777 },
      { mode: 0o44700 },
      { mode: 0o120700 },
      { extra: true }
    ])
      expect(() =>
        recoveryJournal(
          withRoot({ before: { ...before, identity: { ...before.identity, ...patch } } })
        )
      ).toThrow('恢复记录')
    expect(() =>
      recoveryJournal({
        ...journal,
        directoryIdentity: { ...journal.directoryIdentity, mode: 0o40755 }
      })
    ).toThrow('恢复记录')
    const fileIndex = recoveryRoots.indexOf('preferences.json'),
      file = journal.roots[fileIndex]
    file.before = {
      ...asset(file.before),
      identity: { ...asset(file.before).identity, mode: 0o100755 }
    }
    expect(recoveryJournal(journal).roots[fileIndex].before?.identity.mode).toBe(0o100755)
    file.before.identity.mode = 0o40700
    expect(() => recoveryJournal(journal)).toThrow('恢复记录')
  })
  it('refuses a forged, occupied, cross-direction or wrong-source intent', () => {
    const journal = intentFixture('resume', 'candidate', 'current'),
      intent = journal.intent
    if (!intent) throw new Error('Fixture intent missing')
    for (const patch of [
      { root: 'other' },
      { action: 'rollback' },
      { from: 'original' },
      { to: 'displaced' },
      { sha256: fingerprint('a') },
      { identity: { ...intent.identity, ino: intent.identity.ino + 100 } },
      { path: '/outside' }
    ])
      expect(() => recoveryJournal({ ...journal, intent: { ...intent, ...patch } })).toThrow(
        '恢复记录'
      )
    journal.roots[0].baseline = 'current'
    expect(() => recoveryJournal(journal)).toThrow('恢复记录')
    const rollback = intentFixture('rollback', 'original', 'current')
    rollback.roots[0].target = 'current'
    expect(() => recoveryJournal(rollback)).toThrow('恢复记录')
  })
  it('allows only known owned marker names and strict regular 0600 marker identity', () => {
    const journal = fixture()
    for (const name of ['recheck-pending', 'recovery-pending'] as const) {
      journal.marker = {
        name,
        identity: { dev: 1, ino: 99999, uid: 501, mode: 0o100600 },
        sha256: fingerprint('a')
      }
      expect(recoveryJournal(journal).marker).toEqual(journal.marker)
    }
    const marker = journal.marker
    if (!marker) throw new Error('Fixture marker missing')
    for (const patch of [
      { name: 'journal.json' },
      { name: '../recovery-pending' },
      { sha256: 'bad' },
      { identity: { ...marker.identity, mode: 0o120600 } },
      { identity: { ...marker.identity, mode: 0o100644 } },
      { identity: { ...marker.identity, mode: 0o40700 } },
      { content: 'foreign' }
    ])
      expect(() => recoveryJournal({ ...journal, marker: { ...marker, ...patch } })).toThrow(
        '恢复记录'
      )
  })
  it('accepts only complete applied/rolled-back terminal layouts and consistent phase direction', () => {
    const applied = fixture()
    applied.phase = 'applied'
    applied.completed = [...recoveryRoots]
    for (const root of applied.roots) {
      root.baseline = 'original'
      root.target = 'current'
    }
    expect(recoveryJournal(applied)).toEqual(applied)
    applied.roots[0].target = 'candidate'
    expect(() => recoveryJournal(applied)).toThrow('恢复记录')
    const rolledBack = fixture()
    rolledBack.phase = 'rolled-back'
    rolledBack.direction = 'rollback'
    rolledBack.roots.forEach((root, index) => {
      root.target = index % 2 ? 'candidate' : 'displaced'
    })
    expect(recoveryJournal(rolledBack)).toEqual(rolledBack)
    rolledBack.roots[0].baseline = 'original'
    expect(() => recoveryJournal(rolledBack)).toThrow('恢复记录')
    for (const patch of [
      { phase: 'staged', direction: 'rollback' },
      { phase: 'applying', direction: 'rollback' },
      { phase: 'rolling-back', direction: 'resume' },
      { phase: 'rolled-back', direction: 'resume' },
      { completed: [recoveryRoots[0]] },
      { completed: [recoveryRoots[0], recoveryRoots[0]] }
    ])
      expect(() => recoveryJournal({ ...fixture(), ...patch })).toThrow('恢复记录')
    const corruptIntent: RecoveryIntent = {
      action: 'resume',
      root: recoveryRoots[0],
      from: 'current',
      to: 'original',
      ...asset(fixture().roots[0].before)
    }
    expect(() => recoveryJournal({ ...fixture(), intent: corruptIntent })).toThrow('恢复记录')
  })
})

describe('Strict legacy restore metadata without recovery inference', () => {
  it('reads only exact v1 metadata with the original complete plan and fixed completed prefix', () => {
    const value = { version: 1, plan: fixture().plan, phase: 'staged', completed: [] as string[] },
      checked = legacyRecoveryJournal(value)
    expect(checked).toEqual(value)
    checked.plan.id = '22222222-2222-4222-8222-222222222222'
    expect(value.plan.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(
      legacyRecoveryJournal({ ...value, phase: 'applied', completed: [...recoveryRoots] }).phase
    ).toBe('applied')
    for (const phase of ['applying', 'uncertain'])
      expect(
        legacyRecoveryJournal({ ...value, phase, completed: recoveryRoots.slice(0, 2) }).completed
      ).toEqual(recoveryRoots.slice(0, 2))
  })
  it('rejects partial, malformed, reordered, unknown-field or falsely terminal legacy records', () => {
    const value = { version: 1, plan: fixture().plan, phase: 'staged', completed: [] as string[] }
    for (const invalid of [
      { version: 1, phase: 'applied' },
      { version: 1, phase: 'uncertain' },
      { ...value, plan: { ...value.plan, id: 'invalid' } },
      { ...value, plan: { ...value.plan, archiveSHA256: 'invalid' } },
      { ...value, plan: { ...value.plan, containsSecrets: false } },
      { ...value, version: '1' },
      { ...value, version: 2 },
      { ...value, phase: 'rolled-back' },
      { ...value, phase: ['staged'] },
      { ...value, phase: 'applied', completed: [] },
      { ...value, phase: 'applying', completed: [recoveryRoots[1]] },
      { ...value, phase: 'applying', completed: [recoveryRoots[0], recoveryRoots[0]] },
      { ...value, completed: [recoveryRoots[0]] },
      { ...value, sourcePath: '/outside' },
      { ...value, baseline: { snapshot: 'cannot-be-inferred' } }
    ])
      expect(() => legacyRecoveryJournal(invalid)).toThrow('恢复记录')
  })
})
