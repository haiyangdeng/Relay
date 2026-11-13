import { mkdtemp, realpath, rm, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ResourceStore } from './store'
import { readRuleProviderCandidate } from './rule-provider-candidate'
import { resourceHash } from './source'

const expected = { kind: 'rule-yaml', behavior: 'domain' } as const,
  descriptor = { ...expected, name: 'Private source', selector: '' }
async function fixture(run: (cache: ResourceStore) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-provider-candidate-'))
  try {
    await run(
      new ResourceStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay-Preview')
      })
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Immutable cache candidate for one held rule-provider format', () => {
  it('holds independent bytes/current revision and detects later metadata drift without writing', async () =>
    fixture(async (cache) => {
      const original = Buffer.from('payload: [one.invalid]\n'),
        info = await cache.save(descriptor, original),
        selected = { id: info.id, sha256: info.sha256 },
        candidate = await readRuleProviderCandidate(cache, selected, expected),
        path = join(cache.directory, info.id, 'metadata.json'),
        metadata = await readFile(path)
      expect(candidate.job.bytes).toEqual(original)
      expect(candidate.revision).toBe((await cache.read(selected)).revision)
      await candidate.recheck()
      expect(await readFile(path)).toEqual(metadata)
      await writeFile(path, Buffer.concat([metadata, Buffer.from('\n')]))
      await expect(candidate.recheck()).rejects.toThrow('元数据')
      expect((await cache.read(selected)).bytes).toEqual(original)
    }))
  it('refuses a different format/behavior and never treats a candidate as active authority', async () =>
    fixture(async (cache) => {
      const info = await cache.save(descriptor, Buffer.from('payload: [one.invalid]\n')),
        selected = { id: info.id, sha256: info.sha256 }
      for (const target of [
        { kind: 'rule-text', behavior: 'domain' },
        { kind: 'rule-yaml', behavior: 'ipcidr' }
      ] as const)
        await expect(readRuleProviderCandidate(cache, selected, target)).rejects.toThrow('不一致')
      const candidate = await readRuleProviderCandidate(cache, selected, expected)
      expect(Object.keys(candidate).sort()).toEqual(['job', 'recheck', 'revision'])
      candidate.job.bytes.fill(0)
      await expect(candidate.recheck()).rejects.toThrow()
      expect((await cache.read(selected)).bytes.toString()).toBe('payload: [one.invalid]\n')
    }))
  it.each(['descriptor', 'body'])(
    'detects %s mutation inside the last awaited cache read',
    async (target) =>
      fixture(async (cache) => {
        const info = await cache.save(descriptor, Buffer.from('payload: [one.invalid]\n')),
          selected = { id: info.id, sha256: info.sha256 }
        let afterRead = (): void => {}
        const candidate = await readRuleProviderCandidate(
          {
            read: async (selection) => {
              const current = await cache.read(selection)
              afterRead()
              return current
            }
          },
          selected,
          expected
        )
        afterRead = () => {
          if (target === 'descriptor') candidate.job.descriptor.name = 'different valid name'
          else {
            candidate.job.bytes = Buffer.from('payload: [two.invalid]\n')
            candidate.job.sha256 = resourceHash(candidate.job.bytes)
          }
        }
        await expect(candidate.recheck()).rejects.toThrow('描述已变化')
        expect((await cache.read(selected)).bytes.toString()).toBe('payload: [one.invalid]\n')
      })
  )
})
