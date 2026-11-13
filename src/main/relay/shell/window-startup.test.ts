import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultShellSettings } from '../../../shared/relay/shell'
import { RelayShellStore } from './store'
import { defaultWindowStartup, readWindowStartup } from './window-startup'

it('activates only the paired startup settings in the fixed normal owned data root', async () => {
  const home = await realpath(await mkdtemp('/private/tmp/relay-window-startup-'))
  const stateRoot = join(home, 'Library/Application Support/Relay-Preview')
  const store = new RelayShellStore({ stateRoot })
  try {
    expect(readWindowStartup(home, stateRoot)).toEqual(defaultWindowStartup)
    await store.save(
      { ...defaultShellSettings(), useWindowFrame: false, disableHardwareAcceleration: true },
      ''
    )
    expect(readWindowStartup(home, stateRoot)).toEqual({
      useWindowFrame: false,
      disableHardwareAcceleration: true
    })
    expect(readWindowStartup(home, join(home, 'other'))).toEqual(defaultWindowStartup)
    const path = join(stateRoot, 'UI/shell-startup.json'),
      bytes = await readFile(path)
    await rm(path)
    const other = join(home, 'other-startup.json')
    await writeFile(other, bytes, { mode: 0o600 })
    await symlink(other, path)
    expect(readWindowStartup(home, stateRoot)).toEqual(defaultWindowStartup)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('uses the legacy base digest as the common commit point for simultaneous extension-only changes', async () => {
  const home = await realpath(await mkdtemp('/private/tmp/relay-window-pair-'))
  const stateRoot = join(home, 'Library/Application Support/Relay-Preview')
  const path = join(stateRoot, 'UI/shell.json'),
    store = new RelayShellStore({ stateRoot })
  try {
    const base = defaultShellSettings()
    const old = await store.save(
      { ...base, trayTrafficTextColor: 'white', useWindowFrame: true },
      ''
    )
    const priorBytes = await readFile(path)
    const current = await store.save(
      {
        ...base,
        trayTrafficTextColor: 'black',
        useWindowFrame: false,
        disableHardwareAcceleration: true
      },
      old.revision
    )
    const currentBytes = await readFile(path)
    expect(currentBytes.equals(priorBytes)).toBe(false)
    expect(JSON.parse(currentBytes.toString())).toEqual(base)
    expect((await store.read()).settings).toEqual(current.settings)
    // Both extension writes reached disk, but the base rename did not commit.
    await writeFile(path, priorBytes)
    expect(await store.read()).toEqual(old)
    expect(readWindowStartup(home, stateRoot)).toEqual(defaultWindowStartup)
    await writeFile(path, currentBytes)
    expect(await store.read()).toEqual(current)
    expect(readWindowStartup(home, stateRoot)).toEqual({
      useWindowFrame: false,
      disableHardwareAcceleration: true
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
