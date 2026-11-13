import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { coreEnvironment } from '../../src/main/relay/core/configuration'
import { resourceRuleEntries } from '../../src/main/relay/resources/check-definition'
import { resourceHash } from '../../src/main/relay/resources/source'
import { convertRuleMRS } from '../../src/main/relay/resources/mrs-convert'

const exec = promisify(execFile),
  root = await realpath(await mkdtemp('/private/tmp/relay-mrs-convert-'))
const core = await verifyCoreResource(resolve('extra/relay/core'))
const results: { behavior: string; rules: number; stdoutBounded: boolean }[] = []
try {
  for (const [behavior, lines] of [
    ['domain', ['+.example.test', 'exact.fixture.test', '*.wildcard.test']],
    ['ipcidr', ['127.0.0.0/8', '::1/128', '192.0.2.0/24']]
  ] as const) {
    const input = join(root, behavior + '.txt'),
      mrs = join(root, behavior + '.mrs')
    await writeFile(input, lines.join('\n') + '\n', { mode: 0o600 })
    await exec(core.executable, ['convert-ruleset', behavior, 'text', input, mrs], {
      cwd: root,
      env: coreEnvironment(),
      timeout: 10000,
      maxBuffer: 65536
    })
    const bytes = await readFile(mrs)
    const descriptor = { name: 'MRS fixture', kind: 'rule-mrs' as const, behavior, selector: '' }
    assert.equal(
      resourceRuleEntries({ descriptor, bytes, sha256: resourceHash(bytes) }).expected,
      lines.length
    )
    const decoded = await convertRuleMRS(resolve('extra/relay/core'), {
      descriptor,
      bytes,
      sha256: resourceHash(bytes)
    })
    const output = decoded.entries
    assert.deepEqual(new Set(output), new Set(lines))
    results.push({ behavior, rules: output.length, stdoutBounded: true })
  }
  const proof = {
    verifiedAt: new Date().toISOString(),
    coreVersion: core.version,
    scope: 'fixed-core-MRS-conversion-with-per-child-Darwin-sandbox-and-bounded-stdout',
    results,
    networkDeniedByChildSandbox: true,
    maximumInputBytes: 2 * 1024 * 1024,
    maximumOutputBytes: 512 * 1024,
    timeoutMs: 10000,
    actualNetworkConfigured: false,
    productAcceptance: 'pending',
    sourceReference:
      'https://github.com/MetaCubeX/mihomo/blob/v1.19.33/rules/provider/mrs_converter.go'
  }
  await writeFile(
    '../evidence/mrs-converter-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
