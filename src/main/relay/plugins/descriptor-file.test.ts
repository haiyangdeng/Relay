import { mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createDescriptorInbox, readDescriptorFile } from './descriptor-file'

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp('/private/tmp/relay-cpx-file-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
describe('Bounded local CPX source, without installation or network access', () => {
  it('holds only the latest bounded OS-delivered path without reading it and consumes it once', () => {
    const inbox = createDescriptorInbox()
    expect(inbox.hasPending()).toBe(false)
    expect(inbox.offer('/not-read/first.cpx')).toBe(true)
    expect(inbox.offer('/not-read/second.CPX')).toBe(true)
    expect(inbox.offer('https://foreign.invalid/file.cpx')).toBe(false)
    expect(inbox.take()).toBe('/not-read/second.CPX')
    expect(inbox.take()).toBeUndefined()
    expect(inbox.offer('/' + 'a'.repeat(4096) + '.cpx')).toBe(false)
    expect(inbox.offer('/not-read/third.cpx')).toBe(true)
    inbox.clear()
    expect(inbox.hasPending()).toBe(false)
  })
  it('reads exact UTF-8 text and accepts a case-insensitive CPX extension', async () => {
    await fixture(async (root) => {
      const path = join(root, '公开描述.CPX'),
        text = '{"name":"公开描述"}\n'
      await writeFile(path, text, { mode: 0o600 })
      expect(await readDescriptorFile(path)).toBe(text)
    })
  })
  it('refuses non-files, links, oversized bytes and malformed UTF-8', async () => {
    await fixture(async (root) => {
      const path = join(root, 'source.cpx'),
        link = join(root, 'linked.cpx')
      await writeFile(path, Buffer.from([0xc3, 0x28]), { mode: 0o600 })
      await expect(readDescriptorFile(path)).rejects.toThrow()
      await symlink(path, link)
      await expect(readDescriptorFile(link)).rejects.toThrow()
      await writeFile(path, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 })
      await expect(readDescriptorFile(path)).rejects.toThrow()
      await expect(readDescriptorFile(root + '.cpx')).rejects.toThrow()
    })
  })
  it.each([
    'relative.cpx',
    '/private/source.json',
    '/private/a.cpx\0',
    'https://provider.example/plugin.cpx'
  ])('refuses unsupported source syntax before reading: %s', async (path) => {
    await expect(readDescriptorFile(path)).rejects.toThrow('请选择')
  })
})
