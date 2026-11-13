import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'fs/promises'
import { join, resolve } from 'path'
import fs from 'fs'
import { syncBuiltinESMExports } from 'module'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupFileNative } from '../native'
import { backupHash, readBackupArchive } from './archive'
import * as legacy from './legacy-clash'
import { prepareLegacyMigrationRecord } from './legacy-record'

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})
const conversionDirectories = new Set<string>()
afterEach(async () => {
  for (const directory of conversionDirectories)
    await rm(directory, { recursive: true, force: true })
  conversionDirectories.clear()
})

const archive = (): Buffer => {
  const zip = new AdmZip()
  zip.addFile('config.yaml', Buffer.from('{}\n'))
  zip.addFile('mihomo.yaml', Buffer.from('{}\n'))
  zip.addFile('override.yaml', Buffer.from('items: []\n'))
  zip.addFile(
    'profile.yaml',
    Buffer.from('items:\n  - id: legacy-local\n    type: local\n    name: Legacy local\n')
  )
  zip.addFile(
    'profiles/legacy-local.yaml',
    Buffer.from('proxies: []\nproxy-groups: []\nrules: [MATCH,REJECT]\n')
  )
  return zip.toBuffer()
}
async function fixture(
  run: (context: { home: string; stateRoot: string }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-record-'))
  try {
    await run({ home, stateRoot: join(home, 'Library/Application Support/Relay') })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const publisher =
  (context: { home: string; stateRoot: string }) =>
  async (request: Parameters<typeof backupFileNative>[2]) => {
    if (request.name === 'migration.json') {
      const receipt = JSON.parse(Buffer.from(request.bytes, 'base64').toString('utf8'))
      expect(receipt.conversionDirectoryName).toMatch(/^relay-legacy-conversion-[A-Za-z0-9]+$/u)
      conversionDirectories.add(join('/private/tmp', receipt.conversionDirectoryName))
    }
    return backupFileNative(
      process.env.RELAY_BACKUP_MOVE_EXECUTABLE ?? resolve('extra/relay/RelayNative'),
      context,
      request
    )
  }

describe('Private legacy migration record publication', () => {
  it('durably preserves a malformed Clash ZIP before its actual parser fails', async () => {
    await fixture(async (context) => {
      const bytes = Buffer.from('PRIVATE-not-a-ZIP'),
        convert = legacy.convertLegacyClashArchive
      vi.spyOn(legacy, 'convertLegacyClashArchive').mockImplementationOnce(async (input) => {
        conversionDirectories.add(input.temporaryHome)
        const [id] = await readdir(join(context.stateRoot, 'Migrations'))
        expect(await readFile(join(context.stateRoot, 'Migrations', id, 'original.zip'))).toEqual(
          bytes
        )
        return convert(input)
      })
      await expect(
        prepareLegacyMigrationRecord(
          context,
          bytes,
          { directories: [], entries: [] },
          undefined,
          new AbortController().signal,
          publisher(context)
        )
      ).rejects.toThrow('原备份')
      const [id] = await readdir(join(context.stateRoot, 'Migrations')),
        directory = join(context.stateRoot, 'Migrations', id)
      expect(await readdir(directory)).toEqual(['original.zip'])
      expect(await readFile(join(directory, 'original.zip'))).toEqual(bytes)
    })
  })
  it('retains the exact source and metadata report without publishing isolated configurations', async () => {
    await fixture(async (context) => {
      const bytes = archive()
      const prepared = await prepareLegacyMigrationRecord(
        context,
        bytes,
        { directories: [], entries: [] },
        undefined,
        new AbortController().signal,
        publisher(context)
      )
      const directory = join(context.stateRoot, 'Migrations', prepared.migrationId)
      expect(await readFile(join(directory, 'original.zip'))).toEqual(bytes)
      expect((await lstat(join(directory, 'original.zip'))).mode & 0o7777).toBe(0o600)
      expect((await lstat(directory)).mode & 0o7777).toBe(0o700)
      expect(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))).toEqual(
        prepared.report
      )
      const receipt = JSON.parse(await readFile(join(directory, 'migration.json'), 'utf8')),
        conversionDirectory = join('/private/tmp', receipt.conversionDirectoryName)
      expect((await lstat(conversionDirectory)).mode & 0o7777).toBe(0o700)
      expect((await readdir(conversionDirectory)).length).toBeGreaterThan(0)
      expect(JSON.stringify(prepared.report)).not.toContain(conversionDirectory)
      const candidate = prepared.archiveBytes
      if (!candidate) throw new Error('Missing converted archive')
      expect(readBackupArchive(candidate).snapshot.entries.length).toBeGreaterThan(0)
      await expect(lstat(join(context.stateRoot, 'Configurations'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(
        prepared.recordPlan({
          id: '00000000-0000-0000-0000-000000000001',
          archiveSHA256: 'f'.repeat(64),
          baselineSHA256: prepared.expectedBaselineSHA256,
          targetSHA256: 'e'.repeat(64),
          files: 1,
          replacedFiles: 0,
          removedFiles: 0,
          containsSecrets: true,
          preparedAt: Date.now()
        })
      ).rejects.toThrow('不符')
      await expect(lstat(join(directory, 'restore-plan.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      const plan = {
        id: '00000000-0000-0000-0000-000000000001',
        archiveSHA256: backupHash(candidate),
        baselineSHA256: prepared.expectedBaselineSHA256,
        targetSHA256: 'e'.repeat(64),
        files: 1,
        replacedFiles: 0,
        removedFiles: 0,
        containsSecrets: true as const,
        preparedAt: Date.now()
      }
      await prepared.recordPlan(plan)
      expect(
        JSON.parse(await readFile(join(directory, 'restore-plan.json'), 'utf8')).restoreId
      ).toBe(plan.id)
      await expect(prepared.recordPlan(plan)).rejects.toThrow()
    })
  })
  it('preserves a replacement record directory without writing a report or removing foreign data', async () => {
    await fixture(async (context) => {
      const convert = legacy.convertLegacyClashArchive
      let replaced = ''
      let temporaryHome = ''
      vi.spyOn(legacy, 'convertLegacyClashArchive').mockImplementationOnce(async (input) => {
        const result = await convert(input)
        temporaryHome = input.temporaryHome
        conversionDirectories.add(temporaryHome)
        await rename(replaced, replaced + '-retained')
        await mkdir(replaced, { mode: 0o700 })
        await writeFile(join(replaced, 'foreign.json'), 'preserve', { mode: 0o600 })
        return result
      })
      await expect(
        prepareLegacyMigrationRecord(
          context,
          archive(),
          { directories: [], entries: [] },
          undefined,
          new AbortController().signal,
          async (request) => {
            replaced = join(context.stateRoot, 'Migrations', request.id)
            return publisher(context)(request)
          }
        )
      ).rejects.toThrow('没有替换当前资料')
      expect(await readFile(join(replaced, 'foreign.json'), 'utf8')).toBe('preserve')
      expect(await readdir(replaced)).toEqual(['foreign.json'])
      expect(await readFile(join(replaced + '-retained', 'original.zip'))).toBeInstanceOf(Buffer)
      expect((await lstat(temporaryHome)).isDirectory()).toBe(true)
    })
  })
  it('retains an original and inspection report without a candidate when every old profile is missing', async () => {
    await fixture(async (context) => {
      const zip = new AdmZip(archive())
      zip.deleteFile('profiles/legacy-local.yaml')
      const bytes = zip.toBuffer()
      const prepared = await prepareLegacyMigrationRecord(
        context,
        bytes,
        { directories: [], entries: [] },
        undefined,
        new AbortController().signal,
        publisher(context)
      )
      const directory = join(context.stateRoot, 'Migrations', prepared.migrationId)
      expect(prepared.archiveBytes).toBeUndefined()
      expect(prepared.report.counts.profiles).toBe(0)
      expect(prepared.report.profiles).toContainEqual(
        expect.objectContaining({
          legacyId: 'legacy-local',
          disposition: 'decision-required'
        })
      )
      expect(await readFile(join(directory, 'original.zip'))).toEqual(bytes)
      expect(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))).toEqual(
        prepared.report
      )
      await expect(lstat(join(directory, 'restore-plan.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(lstat(join(context.stateRoot, 'Configurations'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    })
  })
  it('refuses a directory swapped after the last Node check before private bytes reach the native publisher', async () => {
    await fixture(async (context) => {
      let replaced = ''
      const publish = publisher(context)
      await expect(
        prepareLegacyMigrationRecord(
          context,
          archive(),
          { directories: [], entries: [] },
          undefined,
          new AbortController().signal,
          async (request) => {
            replaced = join(context.stateRoot, 'Migrations', request.id)
            await rename(replaced, replaced + '-retained')
            await mkdir(replaced, { mode: 0o700 })
            await writeFile(join(replaced, 'foreign.json'), 'preserve', { mode: 0o600 })
            return publish(request)
          }
        )
      ).rejects.toThrow()
      expect(await readdir(replaced)).toEqual(['foreign.json'])
      expect(await readFile(join(replaced, 'foreign.json'), 'utf8')).toBe('preserve')
      expect(await readdir(replaced + '-retained')).toEqual([])
    })
  })
  it('retains private conversion evidence on cancellation without publishing a restore proof', async () => {
    await fixture(async (context) => {
      const convert = legacy.convertLegacyClashArchive,
        controller = new AbortController()
      let temporaryHome = '',
        directory = ''
      vi.spyOn(legacy, 'convertLegacyClashArchive').mockImplementationOnce(async (input) => {
        temporaryHome = input.temporaryHome
        conversionDirectories.add(temporaryHome)
        const result = await convert(input)
        controller.abort()
        return result
      })
      await expect(
        prepareLegacyMigrationRecord(
          context,
          archive(),
          { directories: [], entries: [] },
          undefined,
          controller.signal,
          async (request) => {
            directory = join(context.stateRoot, 'Migrations', request.id)
            return publisher(context)(request)
          }
        )
      ).rejects.toThrow('已取消')
      expect(await readdir(directory)).toEqual(['original.zip'])
      expect((await lstat(temporaryHome)).mode & 0o7777).toBe(0o700)
      expect((await readdir(temporaryHome)).length).toBeGreaterThan(0)
      await expect(lstat(join(context.stateRoot, 'Configurations'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    })
  })
  it('preserves an unknown replacement temporary home and refuses to publish an executable restore proof', async () => {
    await fixture(async (context) => {
      const convert = legacy.convertLegacyClashArchive
      let temporaryHome = ''
      vi.spyOn(legacy, 'convertLegacyClashArchive').mockImplementationOnce(async (input) => {
        const result = await convert(input)
        temporaryHome = input.temporaryHome
        await rename(temporaryHome, temporaryHome + '-retained')
        await mkdir(temporaryHome, { mode: 0o700 })
        await writeFile(join(temporaryHome, 'foreign.json'), 'preserve', { mode: 0o600 })
        return result
      })
      try {
        await expect(
          prepareLegacyMigrationRecord(
            context,
            archive(),
            { directories: [], entries: [] },
            undefined,
            new AbortController().signal,
            publisher(context)
          )
        ).rejects.toThrow('证据目录身份未确认')
        expect(await readdir(temporaryHome)).toEqual(['foreign.json'])
        expect(await readFile(join(temporaryHome, 'foreign.json'), 'utf8')).toBe('preserve')
        const [migrationId] = await readdir(join(context.stateRoot, 'Migrations'))
        await expect(
          lstat(join(context.stateRoot, 'Migrations', migrationId, 'restore-plan.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        if (temporaryHome) {
          await rm(temporaryHome, { recursive: true, force: true })
          await rm(temporaryHome + '-retained', { recursive: true, force: true })
        }
      }
    })
  })
  it('retains both directories when the conversion home is replaced at the final realpath boundary', async () => {
    await fixture(async (context) => {
      const untouchedRealpath = fs.promises.realpath,
        publish = publisher(context)
      let ready = false,
        replaced = ''
      vi.spyOn(fs.promises, 'realpath').mockImplementation(async (path) => {
        const resolved = await untouchedRealpath(path)
        if (
          ready &&
          !replaced &&
          typeof path === 'string' &&
          path.startsWith('/private/tmp/relay-legacy-conversion-')
        ) {
          replaced = path
          await rename(path, path + '-retained')
          conversionDirectories.add(path + '-retained')
          await mkdir(path, { mode: 0o700 })
          await writeFile(join(path, 'foreign.json'), 'preserve', { mode: 0o600 })
        }
        return resolved
      })
      syncBuiltinESMExports()
      await expect(
        prepareLegacyMigrationRecord(
          context,
          archive(),
          { directories: [], entries: [] },
          undefined,
          new AbortController().signal,
          async (request) => {
            const result = await publish(request)
            if (request.name === 'migration.json') ready = true
            return result
          }
        )
      ).rejects.toThrow('证据目录身份未确认')
      expect(replaced).not.toBe('')
      expect(await readdir(replaced)).toEqual(['foreign.json'])
      expect(await readFile(join(replaced, 'foreign.json'), 'utf8')).toBe('preserve')
      expect((await readdir(replaced + '-retained')).length).toBeGreaterThan(0)
      const [migrationId] = await readdir(join(context.stateRoot, 'Migrations'))
      await expect(
        lstat(join(context.stateRoot, 'Migrations', migrationId, 'restore-plan.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
