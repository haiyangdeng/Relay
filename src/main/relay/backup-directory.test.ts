import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBackupDirectory } from './backup-directory'

let home: string
const open = vi.fn(async () => '')
const context = () => ({ home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') })
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'relay-backup-open-')))
  open.mockReset().mockResolvedValue('')
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('Fixed backup directory opener with fixture filesystem', () => {
  it('opens only the two main-owned existing folders and returns no paths', async () => {
    for (const [source, root] of [
      ['relay', 'Relay-Preview'],
      ['legacy', 'AI Network Assistant']
    ]) {
      const directory = join(home, 'Library/Application Support', root, 'Backups')
      await mkdir(directory, { recursive: true })
      expect(await openBackupDirectory(context(), { source }, open)).toEqual({
        status: 'requested',
        source
      })
      expect(open).toHaveBeenLastCalledWith(directory)
    }
  })
  it('does not create a missing folder or fall back to its parent', async () => {
    await expect(openBackupDirectory(context(), { source: 'relay' }, open)).rejects.toThrow(
      '不存在'
    )
    expect(open).not.toHaveBeenCalled()
  })
  it('rejects forged sources, renderer paths and redirected runtime roots', async () => {
    for (const raw of [
      undefined,
      'relay',
      { source: 'unknown' },
      { source: 'relay', path: '/tmp' },
      { source: '../legacy' }
    ]) {
      await expect(openBackupDirectory(context(), raw, open)).rejects.toThrow()
    }
    await expect(
      openBackupDirectory({ home, stateRoot: join(home, 'elsewhere') }, { source: 'relay' }, open)
    ).rejects.toThrow('上下文')
    expect(open).not.toHaveBeenCalled()
  })
  it('rejects a symlink in each writable directory component', async () => {
    const components = ['Library', 'Application Support', 'Relay-Preview', 'Backups']
    for (let index = 0; index < components.length; index++) {
      const root = join(home, 'Library')
      await rm(root, { recursive: true, force: true })
      const parent = join(home, ...components.slice(0, index))
      await mkdir(parent, { recursive: true })
      const destination = join(home, `fixture-target-${index}`)
      await mkdir(destination)
      await symlink(destination, join(parent, components[index]))
      await expect(openBackupDirectory(context(), { source: 'relay' }, open)).rejects.toThrow(
        '不安全'
      )
    }
    expect(open).not.toHaveBeenCalled()
  })
  it('rejects a regular file instead of a folder', async () => {
    await mkdir(context().stateRoot, { recursive: true })
    await writeFile(join(context().stateRoot, 'Backups'), 'private fixture')
    await expect(openBackupDirectory(context(), { source: 'relay' }, open)).rejects.toThrow(
      '不安全'
    )
    expect(open).not.toHaveBeenCalled()
  })
  it('reports an opener failure without leaking it, retrying or falling back', async () => {
    await mkdir(join(context().stateRoot, 'Backups'), { recursive: true })
    open.mockResolvedValue('PRIVATE ERROR')
    await expect(openBackupDirectory(context(), { source: 'relay' }, open)).rejects.toThrow(
      'Finder 打开请求未确认'
    )
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRejectedValue(new Error('PRIVATE ERROR'))
    await expect(openBackupDirectory(context(), { source: 'relay' }, open)).rejects.not.toThrow(
      'PRIVATE'
    )
    expect(open).toHaveBeenCalledTimes(2)
  })
})
