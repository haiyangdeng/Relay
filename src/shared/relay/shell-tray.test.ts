import { describe, expect, it } from 'vitest'
import { shellTrayStatus } from './shell-tray'

describe('Read-only tray observations', () => {
  it.each([
    [false, false, 'white'],
    [true, false, 'blue'],
    [false, true, 'green'],
    [true, true, 'red']
  ] as const)('preserves confirmed systemProxy=%s TUN=%s color', (systemProxy, tun, icon) => {
    expect(shellTrayStatus({ mode: 'rule', systemProxy, tun })).toEqual({
      icon,
      tooltip: `Relay\n模式：Rule\n系统代理：${systemProxy ? '已开启' : '未开启'}\nTUN：${tun ? '已开启' : '未开启'}`
    })
  })

  it.each([
    [undefined, undefined, '未确认', '未确认'],
    [undefined, false, '未确认', '未开启'],
    [undefined, true, '未确认', '已开启'],
    [false, undefined, '未开启', '未确认'],
    [true, undefined, '已开启', '未确认']
  ] as const)(
    'keeps systemProxy=%s TUN=%s unknowns uncolored',
    (systemProxy, tun, proxyText, tunText) => {
      expect(shellTrayStatus({ systemProxy, tun })).toEqual({
        tooltip: `Relay\n模式：未确认\n系统代理：${proxyText}\nTUN：${tunText}`
      })
    }
  )

  it.each([
    ['rule', 'Rule'],
    ['global', 'Global'],
    ['direct', 'Direct']
  ] as const)('displays the explicitly observed %s mode', (mode, text) => {
    expect(shellTrayStatus({ mode, systemProxy: undefined, tun: undefined }).tooltip).toContain(
      `模式：${text}`
    )
  })

  it('rejects invalid observations without coercing string or number flags', () => {
    const invalid: unknown[] = [
      null,
      undefined,
      [],
      'active',
      { systemProxy: 'false', tun: false },
      { systemProxy: 0, tun: false },
      { systemProxy: false, tun: 'true' },
      { systemProxy: false, tun: null },
      { mode: 'Rule', systemProxy: false, tun: false },
      { mode: null, systemProxy: false, tun: false }
    ]
    for (const observation of invalid)
      expect(() => Reflect.apply(shellTrayStatus, undefined, [observation])).toThrow('未确认')
  })

  it('returns a fresh presentation without mutating the observed snapshot', () => {
    const observation = Object.freeze({ mode: 'global', systemProxy: true, tun: false } as const)
    const first = shellTrayStatus(observation)
    first.tooltip = 'changed elsewhere'
    expect(shellTrayStatus(observation)).toEqual({
      icon: 'blue',
      tooltip: 'Relay\n模式：Global\n系统代理：已开启\nTUN：未开启'
    })
    expect(observation).toEqual({ mode: 'global', systemProxy: true, tun: false })
  })
})
