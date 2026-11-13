import { describe, expect, it } from 'vitest'
import { appUpdateURL } from './configuration'
import { appUpdateDistributionScriptHashes, appUpdatePackageInfo } from './macos'
import { appUpdateHash } from './store'

const release = {
  applicationIdentifier: 'local.relay.network.preview',
  packageIdentifier: 'local.relay.network.preview.installer'
}
const component = 'relay-component.pkg'
const systemVolume =
  '<domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>'
const distribution = (elements: string): Buffer =>
  Buffer.from(`<installer-gui-script minSpecVersion="2">${elements}</installer-gui-script>`)
const inspect = (elements: string): string[] =>
  appUpdateDistributionScriptHashes(distribution(systemVolume + elements), release, component)

describe('Relay Installer distribution boundaries', () => {
  it('accepts a local single-component package with static options', () => {
    expect(
      inspect(`
        <options customize="never" require-scripts="false" allow-external-scripts="false"/>
        <choice id="default" visible="false"><pkg-ref id="${release.packageIdentifier}"/></choice>
        <pkg-ref id="${release.packageIdentifier}" onConclusion="none">#${component}</pkg-ref>
        <pkg-ref id="${release.packageIdentifier}">
          <must-close><app id="${release.applicationIdentifier}"/></must-close>
        </pkg-ref>`)
    ).toEqual([])
  })

  it('captures expressions outside the script tag in the same approval set', () => {
    const expressions = ['canSelect()', 'isActive()']
    expect(
      inspect(`
        <choice id="default" selected="${expressions[0]}"/>
        <pkg-ref id="${release.packageIdentifier}" active="${expressions[1]}">${component}</pkg-ref>`)
    ).toEqual(expressions.map((expression) => appUpdateHash(Buffer.from(expression))))
  })

  it('requires the selected target in explicit Installer architecture lists', () => {
    const inspectArchitectures = (value: string, architecture: 'arm64' | 'x64') =>
      appUpdateDistributionScriptHashes(
        distribution(systemVolume + `<options hostArchitectures="${value}"/>`),
        release,
        component,
        architecture
      )
    expect(inspectArchitectures('x86_64, arm64', 'arm64')).toEqual([])
    expect(inspectArchitectures('x86_64', 'x64')).toEqual([])
    expect(() => inspectArchitectures('x86_64', 'arm64')).toThrow('安装描述架构')
    expect(() => inspectArchitectures('arm64', 'x64')).toThrow('安装描述架构')
    expect(() => inspectArchitectures('', 'arm64')).toThrow('安装描述架构')
  })

  it.each([
    ['external scripts', '<options allow-external-scripts="true"/>'],
    ['legacy external script flag', '<options allow-external-scripts="yes"/>'],
    [
      'an unrelated app closure',
      `<pkg-ref id="${release.packageIdentifier}"><must-close><app id="org.example.other"/></must-close></pkg-ref>`
    ],
    [
      'system restart',
      `<pkg-ref id="${release.packageIdentifier}" onConclusion="RequireRestart"/>`
    ],
    [
      'computed conclusion',
      `<pkg-ref id="${release.packageIdentifier}" onConclusionScript="result()"/>`
    ],
    ['relocation', `<pkg-ref id="${release.packageIdentifier}"><relocate/></pkg-ref>`],
    [
      'remote component',
      `<pkg-ref id="${release.packageIdentifier}">https://example.test/relay.pkg</pkg-ref>`
    ]
  ])('refuses %s before returning script hashes', (_label, elements) => {
    expect(() => inspect(elements)).toThrow()
  })

  it.each([
    '',
    systemVolume.replace('enable_anywhere="false"', 'enable_anywhere="true"'),
    systemVolume.replace('enable_currentUserHome="false"', 'enable_currentUserHome="true"'),
    systemVolume.replace('enable_localSystem="true"', 'enable_localSystem="canInstall()"'),
    systemVolume + systemVolume
  ])('rejects missing, alternate, executable, or duplicate install domains (%s)', (domains) => {
    expect(() =>
      appUpdateDistributionScriptHashes(distribution(domains), release, component)
    ).toThrow('安装范围固定在当前系统卷')
  })
})

describe('Relay component package install location', () => {
  it('accepts the empty relocation marker emitted by pkgbuild', () => {
    expect(
      appUpdatePackageInfo(
        Buffer.from(
          '<pkg-info relocatable="false" postinstall-action="none"><relocate/></pkg-info>'
        )
      ).tagName
    ).toBe('pkg-info')
  })

  it.each([
    '<pkg-info relocatable="true"/>',
    '<pkg-info postinstall-action="restart"/>',
    '<pkg-info relocatable="false"><relocate><bundle id="local.relay.network.preview"/></relocate></pkg-info>'
  ])('rejects a system action or relocation (%s)', (metadata) => {
    expect(() => appUpdatePackageInfo(Buffer.from(metadata))).toThrow('不允许系统重启或重定位')
  })
})

it.each(['https://[::1]', 'https://localhost.', 'https://sub.localhost.'])(
  'refuses a local origin even when included in the configured origins (%s)',
  (origin) => {
    expect(() => appUpdateURL(origin + '/release.json', [origin])).toThrow()
  }
)

it('accepts the configured HTTPS publication origin', () => {
  expect(
    appUpdateURL('https://updates.example.test/release.json', ['https://updates.example.test'])
  ).toBe('https://updates.example.test/release.json')
})
