import { mkdtemp, realpath, rm, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { RULE_RESOURCE_PREVIEW_TEXT_LIMIT } from '../../../shared/relay/resources'
import { ResourceStore } from './store'
import { readRuleResourcePreview } from './preview'

async function fixture(run: (cache: ResourceStore) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-rule-preview-'))
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
const descriptor = {
  name: 'Private rules',
  kind: 'rule-text',
  behavior: 'domain',
  selector: ''
} as const

describe('Selected immutable rule-cache preview', () => {
  it('preserves exact UTF-8 text including BOM and never mutates the selected files', async () =>
    fixture(async (cache) => {
      const text = '\uFEFFexample.invalid\n测试.invalid\n',
        info = await cache.save(descriptor, Buffer.from(text)),
        selection = { id: info.id, sha256: info.sha256 },
        before = await cache.read(selection),
        convert = vi.fn(),
        result = await readRuleResourcePreview(cache, selection, vi.fn(), convert)
      expect(result).toEqual({
        resource: selection,
        kind: 'rule-text',
        text,
        language: 'text',
        sourceBytes: Buffer.byteLength(text),
        converted: false
      })
      expect((await cache.read(selection)).revision).toBe(before.revision)
      expect(convert).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain(cache.directory)
    }))
  it('rejects an arbitrary path or extra fields before opening a cache', async () => {
    const read = vi.fn()
    for (const raw of [
      { path: '/private/key' },
      { id: 'bad', sha256: 'a'.repeat(64) },
      { id: '00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64), path: '/private/key' }
    ])
      await expect(readRuleResourcePreview({ read }, raw, vi.fn())).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
  it('refuses opaque/Geo content, invalid UTF-8 and text exceeding the display budget', async () =>
    fixture(async (cache) => {
      const items = [
        await cache.save(
          { ...descriptor, kind: 'runtime-file', behavior: null },
          Buffer.from('PRIVATE_KEY')
        ),
        await cache.save(
          { ...descriptor, kind: 'geoip-dat', behavior: null, selector: 'CUSTOM' },
          Buffer.from('binary')
        ),
        await cache.save(descriptor, Buffer.from([0xff, 0xfe])),
        await cache.save(descriptor, Buffer.alloc(RULE_RESOURCE_PREVIEW_TEXT_LIMIT + 1, 65))
      ]
      for (const info of items)
        await expect(
          readRuleResourcePreview(cache, { id: info.id, sha256: info.sha256 }, vi.fn())
        ).rejects.toThrow()
    }))
  it('delegates MRS to the existing converter and rejects metadata movement after conversion', async () =>
    fixture(async (cache) => {
      const info = await cache.save(
          { ...descriptor, kind: 'rule-mrs' },
          Buffer.from('private binary fixture')
        ),
        selection = { id: info.id, sha256: info.sha256 },
        convert = vi.fn(async () => ({ entries: ['example.invalid'], sourceRules: 1 })),
        result = await readRuleResourcePreview(cache, selection, vi.fn(), convert)
      expect(result).toMatchObject({
        text: 'example.invalid',
        converted: true,
        language: 'text',
        sourceRules: 1
      })
      expect(convert).toHaveBeenCalledOnce()
      const path = join(cache.directory, info.id, 'metadata.json')
      convert.mockImplementationOnce(async () => {
        await writeFile(path, (await readFile(path, 'utf8')) + '\n')
        return { entries: ['example.invalid'], sourceRules: 1 }
      })
      await expect(readRuleResourcePreview(cache, selection, vi.fn(), convert)).rejects.toThrow(
        '元数据'
      )
      expect((await cache.read(selection)).bytes).toEqual(Buffer.from('private binary fixture'))
    }))
  it('does not publish after a held converter loses the view scope or exceeds the output budget', async () =>
    fixture(async (cache) => {
      const info = await cache.save(
          { ...descriptor, kind: 'rule-mrs' },
          Buffer.from('private binary fixture')
        ),
        selection = { id: info.id, sha256: info.sha256 }
      let active = true
      await expect(
        readRuleResourcePreview(
          cache,
          selection,
          () => {
            if (!active) throw new Error('closed')
          },
          async () => {
            active = false
            return { entries: ['example.invalid'], sourceRules: 1 }
          }
        )
      ).rejects.toThrow('closed')
      await expect(
        readRuleResourcePreview(cache, selection, vi.fn(), async () => ({
          entries: ['x'.repeat(RULE_RESOURCE_PREVIEW_TEXT_LIMIT + 1)],
          sourceRules: 1
        }))
      ).rejects.toThrow('512KiB')
    }))
})
