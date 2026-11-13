import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultShellSettings } from '../../../shared/relay/shell'
import type { ShellTrayObservation } from '../../../shared/relay/shell-tray'
import { trayImage, trayTrafficStyle } from './tray-image'

const fixture = vi.hoisted(() => {
  const image = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
    addRepresentation: vi.fn(),
    toDataURL: vi.fn(() => 'data:image/png;base64,cA==')
  }
  const source = {
    isEmpty: vi.fn(() => false),
    resize: vi.fn(() => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('png')
    }))
  }
  return {
    image,
    source,
    menuAppearance: vi.fn(() => 'Dark'),
    fromPath: vi.fn(() => source),
    fromData: vi.fn(() => source)
  }
})
vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: fixture.fromPath,
    createFromDataURL: fixture.fromData,
    createEmpty: vi.fn(() => fixture.image)
  },
  systemPreferences: { getUserDefault: fixture.menuAppearance }
}))
beforeEach(() => {
  vi.clearAllMocks()
  fixture.source.isEmpty.mockReturnValue(false)
  fixture.image.isEmpty.mockReturnValue(false)
  fixture.menuAppearance.mockReturnValue('Dark')
})

const states: [string, ShellTrayObservation, boolean][] = [
  ['template', { systemProxy: undefined, tun: undefined }, true],
  ['template', { systemProxy: false, tun: false }, true],
  ['blue', { systemProxy: true, tun: false }, false],
  ['green', { systemProxy: false, tun: true }, false],
  ['red', { systemProxy: true, tun: true }, false]
]

describe('Relay reverse-squirrel tray assets', () => {
  it.each(states)(
    'uses the Relay %s image for both static and traffic views',
    (name, state, template) => {
      const settings = defaultShellSettings()
      trayImage(settings, state)
      expect(fixture.fromPath).toHaveBeenLastCalledWith(
        expect.stringContaining(`relay-tray-${name}.png`)
      )
      expect(fixture.image.setTemplateImage).toHaveBeenLastCalledWith(template)
      expect(
        fixture.image.addRepresentation.mock.calls.map(([entry]) => entry.scaleFactor)
      ).toEqual([1, 1.25, 1.5, 2, 2.5, 3])
      expect(fixture.source.resize.mock.calls.map(([size]) => size.height)).toEqual([
        18, 23, 27, 36, 45, 54
      ])
      const traffic = trayTrafficStyle(settings, state)
      expect(fixture.fromPath).toHaveBeenLastCalledWith(
        expect.stringContaining(`relay-tray-${name}.png`)
      )
      expect(traffic.colored).toBe(!template)
      expect(fixture.image.toDataURL).toHaveBeenLastCalledWith({ scaleFactor: 3 })
    }
  )

  it.each(states)(
    'keeps the %s status dot while adapting the mascot to a light menu bar',
    (name, state, template) => {
      fixture.menuAppearance.mockReturnValue('')
      const settings = defaultShellSettings()
      trayImage(settings, state)
      expect(fixture.fromPath).toHaveBeenLastCalledWith(
        expect.stringContaining(`relay-tray-${name}${template ? '' : '-dark'}.png`)
      )
      expect(fixture.image.setTemplateImage).toHaveBeenLastCalledWith(template)
      expect(trayTrafficStyle(settings, state).colored).toBe(!template)
    }
  )

  it('uses the Relay template when colors are disabled, and rejects missing images without old fallback', () => {
    const settings = { ...defaultShellSettings(), disableTrayIconColor: true }
    trayImage(settings, { systemProxy: true, tun: true })
    expect(fixture.fromPath).toHaveBeenLastCalledWith(
      expect.stringContaining('relay-tray-template.png')
    )
    fixture.source.isEmpty.mockReturnValue(true)
    expect(() => trayImage(settings, { systemProxy: false, tun: false })).toThrow('随包托盘')
    expect(fixture.fromPath).toHaveBeenCalledTimes(2)
  })

  it('preserves explicit user custom PNGs instead of replacing them with the built-in logo', () => {
    const png = readFileSync(
      new URL('../../../../resources/relay-tray-template.png', import.meta.url)
    )
    const data = `data:image/png;base64,${png.toString('base64')}`
    const settings = defaultShellSettings()
    settings.customTrayIcons.default = data
    trayImage(settings, { systemProxy: true, tun: false })
    expect(fixture.fromData).toHaveBeenCalledWith(data)
    expect(fixture.fromPath).not.toHaveBeenCalled()
    expect(fixture.image.setTemplateImage).toHaveBeenCalledWith(true)
    expect(fixture.source.resize.mock.calls.map(([size]) => size.height)).toEqual([
      16, 20, 24, 32, 40, 48
    ])
  })

  it('ships transparent PNG assets for both menu bar appearances at full 3x resolution', () => {
    for (const name of [
      'template',
      'blue',
      'green',
      'red',
      'blue-dark',
      'green-dark',
      'red-dark'
    ]) {
      const png = readFileSync(
        new URL(`../../../../resources/relay-tray-${name}.png`, import.meta.url)
      )
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(png.readUInt32BE(16)).toBe(54)
      expect(png.readUInt32BE(20)).toBe(54)
      expect(png[25]).toBe(6)
    }
  })
})
