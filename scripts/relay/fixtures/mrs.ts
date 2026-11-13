import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, realpath, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { verifyCoreResource } from '../../../src/main/relay/core/resources'
import { coreEnvironment } from '../../../src/main/relay/core/configuration'
import { readBinaryResource } from '../../../src/main/relay/resources/source'

// Convert only known tiny test strings with the pinned core's non-runtime
// subcommand. No arbitrary source, configuration or network is involved.
export async function mrsFixture(
  resourceRoot: string,
  behavior: 'domain' | 'ipcidr'
): Promise<Buffer> {
  const directory = await realpath(await mkdtemp('/private/tmp/relay-mrs-fixture-')),
    input = join(directory, 'input.txt'),
    output = join(directory, 'fixture.mrs')
  try {
    const resource = await verifyCoreResource(resourceRoot)
    await writeFile(
      input,
      behavior === 'domain' ? 'fixture.invalid\n+.example.invalid\n' : '127.0.0.0/8\n::1/128\n',
      { mode: 0o600 }
    )
    await promisify(execFile)(
      resource.executable,
      ['convert-ruleset', behavior, 'text', input, output],
      {
        cwd: directory,
        env: coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
        timeout: 8000,
        maxBuffer: 65536
      }
    )
    return await readBinaryResource(output)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
