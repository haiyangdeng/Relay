import { mkdtemp, mkdir, realpath, writeFile, rm, chmod, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { externalDiagnosticRecord } from '../../shared/relay/diagnostic-evidence'
import { createDiagnosticEvidenceReader } from './diagnostic-evidence'

function ownedDiagnosticFixture() {
  return {
    record: externalDiagnosticRecord({
      schemaVersion: 1,
      recordedAt: '2026-11-14T01:00:00Z',
      binding: {
        architecture: 'x64',
        appVersion: '1.0.0',
        appBuild: '7',
        coreSHA256: 'd'.repeat(64),
        configurationRevision: 'c'.repeat(64)
      },
      tests: [
        {
          id: 'webrtc',
          testedAt: '2026-11-14T00:59:00Z',
          result: 'noLeakObserved',
          browser: { bundleId: 'com.google.Chrome', version: '100.0', profile: 'relay-private' },
          method: 'Dedicated browser ICE fixture',
          scope: ['Only this browser probe'],
          limitations: ['No packet capture or system filter test'],
          evidenceSHA256: 'e'.repeat(64)
        }
      ]
    })
  }
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'relay-diagnostics-'))
  roots.push(home)
  const stateRoot = join(home, 'Library/Application Support/Relay-Preview')
  const reader = createDiagnosticEvidenceReader({ home, stateRoot })
  const directory = join(stateRoot, 'Diagnostics')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const record = ownedDiagnosticFixture().record
  return {
    reader,
    record,
    directory,
    write: () => writeFile(reader.path, JSON.stringify(record), { mode: 0o600 })
  }
}
describe('Private external diagnostic evidence', () => {
  it('reads only its fixed private regular file and leaves missing records absent', async () => {
    const f = await fixture()
    expect(await f.reader.read()).toEqual({ status: 'missing' })
    await f.write()
    expect(await f.reader.read()).toEqual({ status: 'available', record: f.record })
  })
  it.each(['permissions', 'symlink', 'hardlink', 'oversize', 'parent-link', 'malformed'])(
    `rejects %s records`,
    async (kind) => {
      const f = await fixture()
      await f.write()
      if (kind === 'permissions') await chmod(f.reader.path, 0o644)
      if (kind === 'hardlink') await link(f.reader.path, f.reader.path + '.copy')
      if (kind === 'symlink') {
        await rm(f.reader.path)
        await symlink('/etc/hosts', f.reader.path)
      }
      if (kind === 'oversize') await writeFile(f.reader.path, ' '.repeat(65537))
      if (kind === 'malformed') await writeFile(f.reader.path, '{}')
      if (kind === 'parent-link') {
        await rm(f.directory, { recursive: true })
        const target = f.directory + '-other'
        await mkdir(target, { mode: 0o700 })
        await symlink(target, f.directory)
      }
      expect(await f.reader.read()).toEqual({ status: 'invalid' })
    }
  )
  it.each(['guard', 'request', 'callback', 'egress'])(
    `does not accept a leakage pass for %s`,
    (id) => {
      const record = ownedDiagnosticFixture().record
      Object.assign(record.tests[0], { id })
      expect(() => externalDiagnosticRecord(record)).toThrow()
    }
  )
  it('requires browser identity, method, bounded scope, limitations and matching test result semantics', () => {
    for (const field of ['browser', 'method', 'scope', 'limitations', 'evidenceSHA256']) {
      const record = ownedDiagnosticFixture().record
      delete (record.tests[0] as unknown as Record<string, unknown>)[field]
      expect(() => externalDiagnosticRecord(record)).toThrow()
    }
    const record = ownedDiagnosticFixture().record
    record.tests[0].result = 'isolatedPassed'
    expect(() => externalDiagnosticRecord(record)).toThrow()
  })
})
