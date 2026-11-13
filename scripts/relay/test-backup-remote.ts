// Fixed HTTPS API injection only. No real account, remote network or user files.
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import type { requestOnce } from '../../src/main/resolve/plugin/http-client'
import { generateAgeKeyPair } from '../../src/main/utils/age'
import { RelayBackupStore } from '../../src/main/relay/backup/store'
import { createBackupService } from '../../src/main/relay/backup/service'
import { createRemoteBackupService } from '../../src/main/relay/backup/remote-service'
import { createRemoteBackupTransport } from '../../src/main/relay/backup/remote'
import { recoveryFixtureAdapters } from '../../src/main/relay/backup/recovery.test-fixture'

const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const home = await realpath(await mkdtemp('/private/tmp/relay-backup-remote-contract-'))
const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
let count = 0,
  correctRoutes = true,
  restoreAllowed = false,
  refreshed = 0
let createdGist: { public: boolean; files: Record<string, { content: string }> } | undefined
let webdavBytes: Buffer | undefined
const gistId = 'f'.repeat(32)
const request: typeof requestOnce = async (url, options) => {
  count++
  correctRoutes &&=
    url.startsWith('https://api.github.com/gists') ||
    url === 'https://dav.fixture/Relay/unique.json'
  correctRoutes &&=
    options.proxy?.host === '127.0.0.1' &&
    options.proxy.port === 17891 &&
    options.captureRedirects === true
  const response = (status: number, bytes: Buffer = Buffer.alloc(0)) => ({
    status,
    bytes,
    body: '',
    headers: {}
  })
  if (url === 'https://api.github.com/gists' && options.method === 'POST') {
    createdGist = JSON.parse(String(options.body))
    return response(
      201,
      Buffer.from(
        JSON.stringify({
          ...createdGist,
          id: gistId,
          truncated: false,
          files: {
            'relay-backup.json': {
              content: createdGist?.files['relay-backup.json'].content,
              truncated: false
            }
          }
        })
      )
    )
  }
  if (url === `https://api.github.com/gists/${gistId}` && options.method === 'GET')
    return response(
      200,
      Buffer.from(
        JSON.stringify({
          ...createdGist,
          id: gistId,
          truncated: false,
          files: {
            'relay-backup.json': {
              content: createdGist?.files['relay-backup.json'].content,
              truncated: false
            }
          }
        })
      )
    )
  if (url === 'https://dav.fixture/Relay/unique.json') {
    if (options.method === 'PUT') {
      if (options.headers?.['If-None-Match'] !== '*')
        throw new Error('missing create-only condition')
      if (webdavBytes) return response(412)
      webdavBytes = Buffer.from(options.body ?? '')
      return response(201)
    }
    if (options.method === 'GET' && webdavBytes) return response(200, webdavBytes)
  }
  throw new Error('unexpected fixture route')
}
try {
  await mkdir(join(context.stateRoot, 'Configuration'), { recursive: true, mode: 0o700 })
  const target = join(context.stateRoot, 'Configuration/configuration-edit.json')
  await writeFile(target, 'backed-up-version', { mode: 0o600 })
  const store = new RelayBackupStore(context, recoveryFixtureAdapters(context))
  const local = createBackupService({
    store,
    pickImport: async () => undefined,
    writeExport: async () => false,
    confirmExport: async () => false,
    confirmRestore: async () => restoreAllowed,
    assertIdle: () => {},
    afterRestore: () => {
      refreshed++
    }
  })
  let transferAllowed = false
  const remote = createRemoteBackupService({
    store,
    prepareArchive: (bytes, signal) => local.prepareArchive(bytes, signal),
    assertIdle: () => {},
    confirmTransfer: async () => transferAllowed,
    transport: createRemoteBackupTransport(request)
  })
  const keys = await generateAgeKeyPair()
  const gistInput = {
    provider: 'gist',
    action: 'upload',
    proxyPort: 17891,
    token: 'fixture-token-never-saved',
    recipient: keys.recipient
  }
  const cancelled = await remote.prepare(gistInput)
  check(
    'prepare makes no remote requests or return credentials',
    count === 0 && !JSON.stringify(cancelled).includes('fixture-token')
  )
  check(
    'native transfer cancellation sends nothing',
    (await remote.execute({ evidenceId: cancelled.evidenceId })).status === 'cancelled' &&
      count === 0
  )
  transferAllowed = true
  const prepared = await remote.prepare(gistInput)
  const uploaded = await remote.execute({ evidenceId: prepared.evidenceId })
  check(
    'confirmed Gist creates a new non-public backup and verifies readback',
    uploaded.status === 'uploaded' &&
      uploaded.gistId === gistId &&
      createdGist?.public === false &&
      count === 2
  )
  const envelope = JSON.parse(createdGist?.files['relay-backup.json'].content ?? '{}')
  check(
    'Gist envelope contains AGE ciphertext and bounded ZIP integrity metadata',
    envelope.encoding === 'age' &&
      envelope.payload.startsWith('-----BEGIN AGE ENCRYPTED FILE-----') &&
      /^[a-f0-9]{64}$/u.test(envelope.archiveSHA256)
  )
  await writeFile(target, 'current-version', { mode: 0o600 })
  const downloadInput = {
    provider: 'gist',
    action: 'download',
    proxyPort: 17891,
    gistId,
    token: 'fixture-token-never-saved',
    secretKey: keys.secretKey
  }
  const read = await remote.prepare(downloadInput)
  const inspected = await remote.execute({ evidenceId: read.evidenceId })
  check(
    'download decrypts and stages through the local restore proof without replacement',
    inspected.status === 'prepared' &&
      !!inspected.plan &&
      (await readFile(target, 'utf8')) === 'current-version'
  )
  check(
    'separate native restore cancellation preserves current files',
    (await local.restore({ id: inspected.plan?.id })).status === 'cancelled' &&
      (await readFile(target, 'utf8')) === 'current-version'
  )
  const readAgain = await remote.prepare(downloadInput)
  const ready = await remote.execute({ evidenceId: readAgain.evidenceId })
  restoreAllowed = true
  check(
    'explicit second confirmation restores checked private bytes',
    (await local.restore({ id: ready.plan?.id })).status === 'restored' &&
      (await readFile(target, 'utf8')) === 'backed-up-version' &&
      refreshed === 1
  )
  check(
    'restore preserves original data in its private recovery journal',
    (await readFile(
      join(
        context.stateRoot,
        `ApplicationBackups/restore-${ready.plan?.id}/original/Configuration/configuration-edit.json`
      ),
      'utf8'
    )) === 'current-version'
  )
  const conflictRead = await remote.prepare(downloadInput)
  const conflict = await remote.execute({ evidenceId: conflictRead.evidenceId })
  await writeFile(target, 'unknown-edit', { mode: 0o600 })
  let refused = false
  try {
    await local.restore({ id: conflict.plan?.id })
  } catch {
    refused = true
  }
  check(
    'unknown local edits after remote inspection refuse activation',
    refused && (await readFile(target, 'utf8')) === 'unknown-edit'
  )
  const dav = {
    provider: 'webdav',
    action: 'upload',
    proxyPort: 17891,
    url: 'https://dav.fixture/Relay/unique.json',
    username: 'fixture',
    password: 'fixture-password'
  }
  const davPrepared = await remote.prepare(dav)
  check(
    'WebDAV creates only the specified file and verifies its exact bytes',
    (await remote.execute({ evidenceId: davPrepared.evidenceId })).status === 'uploaded' &&
      !!webdavBytes
  )
  const prior = webdavBytes
  const existing = await remote.prepare(dav)
  check(
    'existing WebDAV backup is never overwritten or retried automatically',
    (await remote.execute({ evidenceId: existing.evidenceId })).status === 'uncertain' &&
      webdavBytes === prior
  )
  check('all injected requests retain the fixed HTTPS source and explicit proxy', correctRoutes)
  remote.cancel()
} catch {
  check('remote fixture contract completes', false)
} finally {
  await rm(home, { recursive: true, force: true })
}
const passed = rows.filter((row) => row.passed).length
process.stdout.write(
  JSON.stringify(
    {
      checks: rows.length,
      passed,
      rows,
      fixtureAccepted: passed === rows.length,
      actualRemoteAccountUsed: false,
      externalNetworkUsed: false,
      userDirectoryRestore: false,
      systemConfigurationChanged: false
    },
    null,
    2
  ) + '\n'
)
process.exitCode = passed === rows.length ? 0 : 1
