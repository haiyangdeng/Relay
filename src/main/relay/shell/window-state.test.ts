import {
  mkdtemp,
  realpath,
  rm,
  stat,
  readFile,
  writeFile,
  chmod,
  symlink,
  link,
  rename
} from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampWindowState,
  createWindowGeometryService,
  parseWindowState,
  RelayWindowStateStore,
  type RelayWindowState,
  type WindowDisplay
} from './window-state'

const homes: string[] = [],
  displays: WindowDisplay[] = [
    { id: 'left', workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { id: 'primary', workArea: { x: 0, y: 0, width: 1440, height: 900 } }
  ],
  saved = (x = 100, y = 50, width = 1180, height = 800): RelayWindowState => ({
    version: 1,
    normalBounds: { x, y, width, height },
    maximized: false
  })
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
async function fixture() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-window-state-'))
  homes.push(home)
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    store = new RelayWindowStateStore(context),
    path = join(context.stateRoot, 'UI/window.json')
  return { home, context, store, path }
}
describe('Window geometry uses normal outer bounds in display DIP coordinates', () => {
  it('centers defaults on the primary screen and preserves visible negative positions', () => {
    expect(clampWindowState(undefined, displays, 'primary')).toEqual({
      bounds: { x: 130, y: 50, width: 1180, height: 800 },
      minWidth: 960,
      minHeight: 640,
      maximized: false
    })
    expect(
      clampWindowState({ ...saved(-1800, 80), maximized: true }, displays, 'primary')
    ).toMatchObject({
      bounds: { x: -1800, y: 80, width: 1180, height: 800 },
      maximized: true
    })
  })
  it('selects the largest intersection and fits the entire frame in the selected work area', () => {
    expect(clampWindowState(saved(-100, 500), displays, 'left').bounds).toEqual({
      x: 0,
      y: 100,
      width: 1180,
      height: 800
    })
    expect(clampWindowState(saved(-2200, -300, 3000, 1500), displays, 'primary').bounds).toEqual({
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080
    })
  })
  it('recovers a disconnected monitor position to the nearest remaining screen', () => {
    expect(clampWindowState(saved(-6000, -2000), displays, 'primary').bounds.x).toBe(-1920)
    expect(clampWindowState(saved(5000, 1000), displays, 'left').bounds).toEqual({
      x: 260,
      y: 100,
      width: 1180,
      height: 800
    })
    expect(clampWindowState(saved(-1800, 80), [displays[1]], 'primary').bounds.x).toBe(0)
  })
  it('adapts minimum sizes to small displays and provides a fallback if no screen is reported', () => {
    expect(
      clampWindowState(
        saved(100, 100),
        [{ id: 1, workArea: { x: 20, y: 40, width: 800, height: 600 } }],
        1
      )
    ).toEqual({
      bounds: { x: 20, y: 40, width: 800, height: 600 },
      minWidth: 800,
      minHeight: 600,
      maximized: false
    })
    expect(clampWindowState(undefined, [], undefined).bounds).toEqual({
      x: 0,
      y: 0,
      width: 1180,
      height: 800
    })
  })
  it.each([
    null,
    [],
    { ...saved(), version: 2 },
    { ...saved(), extra: true },
    { ...saved(), maximized: 'true' },
    saved(1.5),
    saved(NaN),
    saved(Infinity),
    saved(0, 0, 0),
    saved(0, 0, -1),
    saved(Number.MAX_SAFE_INTEGER, 0),
    { ...saved(), normalBounds: { ...saved().normalBounds, x: '1' } }
  ])('rejects malformed geometry without coercion: %j', (input) => {
    expect(() => parseWindowState(input)).toThrow()
  })
})
describe('Floating geometry uses its fixed size and retains visible saved coordinates', () => {
  it('centers a fixed floating window without inheriting the main window minimum or maximization', () => {
    expect(clampWindowState(undefined, displays, 'primary', 'floating')).toEqual({
      bounds: { x: 590, y: 395, width: 260, height: 110 },
      minWidth: 260,
      minHeight: 110,
      maximized: false
    })
    expect(
      clampWindowState(
        { ...saved(-1800, 80, 1800, 1000), maximized: true },
        displays,
        'primary',
        'floating'
      )
    ).toEqual({
      bounds: { x: -1800, y: 80, width: 260, height: 110 },
      minWidth: 260,
      minHeight: 110,
      maximized: false
    })
  })
  it('uses the floating footprint for monitor selection and clamps after a monitor disconnects', () => {
    expect(
      clampWindowState(saved(-200, 100, 1180, 800), displays, 'primary', 'floating').bounds
    ).toEqual({
      x: -260,
      y: 100,
      width: 260,
      height: 110
    })
    expect(clampWindowState(saved(-1800, 80), [displays[1]], 'primary', 'floating').bounds).toEqual(
      {
        x: 0,
        y: 80,
        width: 260,
        height: 110
      }
    )
  })
  it('fits tiny work areas and keeps a floating-sized fallback', () => {
    expect(
      clampWindowState(
        saved(200, 300),
        [{ id: 'tiny', workArea: { x: 20, y: 40, width: 200, height: 80 } }],
        'tiny',
        'floating'
      )
    ).toEqual({
      bounds: { x: 20, y: 40, width: 200, height: 80 },
      minWidth: 200,
      minHeight: 80,
      maximized: false
    })
    expect(clampWindowState(undefined, [], undefined, 'floating').bounds).toEqual({
      x: 460,
      y: 345,
      width: 260,
      height: 110
    })
    const geometry = createWindowGeometryService({
      kind: 'floating',
      store: { read: vi.fn(), save: vi.fn() },
      displays: () => {
        throw new Error('screen unavailable')
      },
      primaryId: () => 'primary'
    })
    expect(geometry.resolve().bounds).toEqual({ x: 460, y: 345, width: 260, height: 110 })
  })
  it('rejects arbitrary window kinds instead of interpreting them as a path or policy', async () => {
    const f = await fixture()
    expect(() => Reflect.construct(RelayWindowStateStore, [f.context, '../other.json'])).toThrow(
      '类型'
    )
    expect(() =>
      Reflect.apply(clampWindowState, undefined, [undefined, displays, 'primary', 'other'])
    ).toThrow('类型')
    expect(() =>
      Reflect.apply(createWindowGeometryService, undefined, [{ kind: 'other' }])
    ).toThrow('类型')
    await expect(stat(f.context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
describe('Window state stays in the Relay private directory', () => {
  it('keeps floating and main records private and revision-independent', async () => {
    const f = await fixture(),
      floating = new RelayWindowStateStore(f.context, 'floating'),
      floatingPath = join(f.context.stateRoot, 'UI/floating-window.json')
    expect(await floating.read()).toEqual({ revision: '', writable: true, warnings: [] })
    await expect(stat(f.context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const mainRevision = await f.store.save(saved(), ''),
      mainBytes = await readFile(f.path),
      floatingRevision = await floating.save(saved(-1800, 80, 260, 110), '')
    expect((await stat(floatingPath)).mode & 0o777).toBe(0o600)
    expect((await f.store.read()).revision).toBe(mainRevision)
    expect(await readFile(f.path)).toEqual(mainBytes)
    await expect(floating.save(saved(200, 100, 260, 110), '')).rejects.toThrow('已改变')
    expect((await floating.read()).revision).toBe(floatingRevision)
    await writeFile(floatingPath, '{broken')
    expect((await floating.read()).writable).toBe(false)
    await expect(floating.save(saved(), floatingRevision)).rejects.toThrow('不可写')
    expect(await readFile(floatingPath, 'utf8')).toBe('{broken')
    expect(await readFile(f.path)).toEqual(mainBytes)
  })
  it('does not create storage when reading missing data and atomically saves private files', async () => {
    const f = await fixture()
    expect(await f.store.read()).toEqual({ revision: '', writable: true, warnings: [] })
    await expect(stat(f.context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const revision = await f.store.save(saved(-1700, 80), '')
    expect(await f.store.read()).toMatchObject({
      saved: saved(-1700, 80),
      revision,
      writable: true
    })
    expect((await stat(f.path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(f.context.stateRoot, 'UI'))).mode & 0o777).toBe(0o700)
    const next = { ...saved(200), maximized: true }
    await f.store.save(next, revision)
    expect((await f.store.read()).saved).toEqual(next)
    await expect(f.store.save(saved(), revision)).rejects.toThrow('已改变')
    expect((await f.store.read()).saved).toEqual(next)
  })
  it.each(['json', 'empty', 'size', 'permission'] as const)(
    'preserves a %s failure instead of resetting or repairing it',
    async (kind) => {
      const f = await fixture()
      await f.store.save(saved(), '')
      if (kind === 'json') await writeFile(f.path, '{broken')
      if (kind === 'empty') await writeFile(f.path, '')
      if (kind === 'size') await writeFile(f.path, ' '.repeat(16385))
      if (kind === 'permission') await chmod(f.path, 0o644)
      const before = await readFile(f.path)
      expect(await f.store.read()).toMatchObject({
        writable: false,
        warnings: [expect.any(String)]
      })
      await expect(f.store.save(saved(), '')).rejects.toThrow('不可写')
      expect(await readFile(f.path)).toEqual(before)
      if (kind === 'permission') expect((await stat(f.path)).mode & 0o777).toBe(0o644)
    }
  )
  it.each(['symlink', 'dangling', 'hardlink'] as const)(
    'rejects %s records without touching the target',
    async (kind) => {
      const f = await fixture(),
        target = join(f.home, 'retained.json')
      await f.store.save(saved(), '')
      await writeFile(target, JSON.stringify(saved()), { mode: 0o600 })
      await rm(f.path)
      if (kind === 'hardlink') await link(target, f.path)
      else await symlink(kind === 'dangling' ? join(f.home, 'missing') : target, f.path)
      const before = await readFile(target)
      expect((await f.store.read()).writable).toBe(false)
      await expect(f.store.save(saved(), '')).rejects.toThrow()
      expect(await readFile(target)).toEqual(before)
    }
  )
  it('rejects a linked UI directory and preserves the file in it', async () => {
    const f = await fixture(),
      ui = join(f.context.stateRoot, 'UI'),
      target = ui + '-retained'
    await f.store.save(saved(), '')
    await rename(ui, target)
    await symlink(target, ui)
    const before = await readFile(join(target, 'window.json'))
    expect((await f.store.read()).writable).toBe(false)
    await expect(f.store.save(saved(), '')).rejects.toThrow()
    expect(await readFile(join(target, 'window.json'))).toEqual(before)
  })
})
describe('Window geometry lifecycle performs IO only during explicit restore and save', () => {
  it('normalizes only floating size and leaves restored floating files untouched after invalidation', async () => {
    const f = await fixture(),
      store = new RelayWindowStateStore(f.context, 'floating'),
      path = join(f.context.stateRoot, 'UI/floating-window.json'),
      geometry = createWindowGeometryService({
        kind: 'floating',
        store,
        displays: () => displays,
        primaryId: () => 'primary'
      })
    const revision = await store.save({ ...saved(-1800, 80), maximized: true }, '')
    expect(await geometry.restore()).toMatchObject({
      bounds: { x: -1800, y: 80, width: 260, height: 110 },
      maximized: false,
      writable: true
    })
    expect((await store.read()).revision).toBe(revision)
    geometry.capture({
      normalBounds: saved(1300, 850, 800, 600).normalBounds,
      maximized: true,
      minimized: false,
      fullscreen: false
    })
    await geometry.save()
    expect((await store.read()).saved).toEqual(saved(1180, 790, 260, 110))
    const restored = saved(30, 40, 260, 110)
    await writeFile(path, JSON.stringify(restored), { mode: 0o600 })
    geometry.invalidate()
    geometry.capture({
      normalBounds: saved(80, 90, 260, 110).normalBounds,
      maximized: false,
      minimized: false,
      fullscreen: false
    })
    await geometry.save()
    expect((await store.read()).saved).toEqual(restored)
  })
  function service() {
    const store = {
        read: vi.fn(async () => ({
          saved: saved(),
          revision: 'a',
          writable: true,
          warnings: [] as string[]
        })),
        save: vi.fn(async (_value: RelayWindowState, _revision: string) => 'b')
      },
      geometry = createWindowGeometryService({
        store,
        displays: () => displays,
        primaryId: () => 'primary'
      })
    return { store, geometry }
  }
  it('keeps move and resize captures in memory and ignores minimized or fullscreen bounds', async () => {
    const f = service()
    expect(f.store.read).not.toHaveBeenCalled()
    await f.geometry.restore()
    for (let i = 0; i < 100; i++)
      f.geometry.capture({
        normalBounds: saved(i).normalBounds,
        maximized: false,
        minimized: false,
        fullscreen: false
      })
    f.geometry.capture({
      normalBounds: saved(-4000, -4000).normalBounds,
      maximized: false,
      minimized: true,
      fullscreen: false
    })
    f.geometry.capture({
      normalBounds: saved(-4000, -4000).normalBounds,
      maximized: false,
      minimized: false,
      fullscreen: true
    })
    expect(f.store.save).not.toHaveBeenCalled()
    await f.geometry.save()
    expect(f.store.save).toHaveBeenCalledOnce()
    expect(f.store.save).toHaveBeenCalledWith(saved(99), 'a')
  })
  it('captures normal bounds while maximized and drains captures queued during a save without overlapping writes', async () => {
    const f = service()
    await f.geometry.restore()
    let release: () => void = () => {
      throw new Error('Fixture was not started')
    }
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.store.save.mockImplementationOnce(async () => {
      await gate
      return 'b'
    })
    f.geometry.capture({
      normalBounds: saved(120).normalBounds,
      maximized: true,
      minimized: false,
      fullscreen: false
    })
    const pending = f.geometry.save()
    expect(f.geometry.state().pending).toBe(true)
    f.geometry.capture({
      normalBounds: saved(150).normalBounds,
      maximized: true,
      minimized: false,
      fullscreen: false
    })
    expect(f.geometry.save()).toBe(pending)
    let idle = false
    const drained = f.geometry.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    release()
    await Promise.all([pending, drained])
    expect(f.store.save).toHaveBeenCalledTimes(2)
    expect(f.store.save.mock.calls[1]).toEqual([{ ...saved(150), maximized: true }, 'b'])
    expect(f.geometry.state()).toMatchObject({ pending: false, dirty: false })
  })
  it('allows safe shutdown on asynchronous read or write failure and does not silently retry writes', async () => {
    const f = service()
    f.store.read.mockRejectedValueOnce(new Error('disk error'))
    expect(await f.geometry.restore()).toMatchObject({
      writable: false,
      warnings: [expect.any(String)]
    })
    await expect(f.geometry.save()).resolves.toBeUndefined()
    expect(f.store.save).not.toHaveBeenCalled()
    const g = service()
    await g.geometry.restore()
    g.geometry.capture({
      normalBounds: saved(120).normalBounds,
      maximized: false,
      minimized: false,
      fullscreen: false
    })
    g.store.save.mockRejectedValueOnce(new Error('disk error'))
    await expect(g.geometry.save()).resolves.toBeUndefined()
    await expect(g.geometry.whenIdle()).resolves.toBeUndefined()
    await g.geometry.save()
    expect(g.store.save).toHaveBeenCalledOnce()
    expect(g.geometry.state()).toMatchObject({ writable: false, warnings: [expect.any(String)] })
  })
  it('never overwrites a corrupt real record when later captures are flushed', async () => {
    const f = await fixture()
    await f.store.save(saved(), '')
    await writeFile(f.path, '{broken')
    const geometry = createWindowGeometryService({
      store: f.store,
      displays: () => displays,
      primaryId: () => 'primary'
    })
    expect(await geometry.restore()).toMatchObject({ writable: false })
    geometry.capture({
      normalBounds: saved(200).normalBounds,
      maximized: true,
      minimized: false,
      fullscreen: false
    })
    await geometry.save()
    expect(await readFile(f.path, 'utf8')).toBe('{broken')
  })
  it('invalidates the old in-memory baseline after backup restore without overwriting the restored file', async () => {
    const f = await fixture()
    await f.store.save(saved(), '')
    const geometry = createWindowGeometryService({
      store: f.store,
      displays: () => displays,
      primaryId: () => 'primary'
    })
    await geometry.restore()
    geometry.capture({
      normalBounds: saved(200).normalBounds,
      maximized: true,
      minimized: false,
      fullscreen: false
    })
    const restored = { ...saved(80), maximized: true }
    await writeFile(f.path, JSON.stringify(restored), { mode: 0o600 })
    geometry.invalidate()
    expect(await geometry.restore()).toMatchObject({ writable: false })
    await geometry.save()
    expect((await f.store.read()).saved).toEqual(restored)
    const nextLaunch = createWindowGeometryService({
      store: f.store,
      displays: () => displays,
      primaryId: () => 'primary'
    })
    expect(await nextLaunch.restore()).toMatchObject({
      bounds: restored.normalBounds,
      maximized: true,
      writable: true
    })
  })
  it('does not revive persistence if invalidation races an asynchronous initial read', async () => {
    const f = service()
    let release: () => void = () => {
      throw new Error('Fixture not started')
    }
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      read = f.store.read.getMockImplementation()
    if (!read) throw new Error('Fixture read is missing')
    f.store.read.mockImplementationOnce(async () => {
      await gate
      return read()
    })
    const restoring = f.geometry.restore()
    f.geometry.invalidate()
    release()
    expect(await restoring).toMatchObject({ writable: false })
    f.geometry.capture({
      normalBounds: saved(120).normalBounds,
      maximized: false,
      minimized: false,
      fullscreen: false
    })
    await f.geometry.save()
    expect(f.store.save).not.toHaveBeenCalled()
  })
})
