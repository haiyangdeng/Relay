#!/usr/bin/env python3
"""Portable, opt-in macOS resource and release build. Never installs or launches Relay."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.relay-build/public'
RESOURCE = ROOT / 'extra/relay'
COMMIT = '3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8'
VERSION = 'relay-geodata-v1p1-3f27'
NATIVE_PINS = [
    'native/tun/RelayTunExecutionReceiptV2.swift',
    'native/tun/RelayTunHelperTrust.swift',
    'native/tun/RelayTunRuntimeRuleProviderProbe.swift',
    'native/tun/RelayTunRuntimeResourcesIOTests.swift',
    'scripts/relay/test-native-resource-runtime.test.ts',
    'scripts/relay/test-native-rule-provider-runtime.test.ts',
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def run(*args, cwd=ROOT, env=None):
    subprocess.run([str(value) for value in args], cwd=cwd, env=env, check=True)


def output(*args):
    return subprocess.check_output([str(value) for value in args], cwd=ROOT, text=True).strip()


def plain_tree(directory):
    if directory.is_symlink():
        raise RuntimeError('Symlink is not accepted: ' + str(directory))
    for path in directory.rglob('*'):
        if path.is_symlink() or (not path.is_file() and not path.is_dir()):
            raise RuntimeError('Non-regular build input: ' + str(path))


def source_inventory():
    files = []
    for name in ['src', 'native', 'core-extensions', 'scripts', 'resources', 'build', 'docs', 'patches']:
        files.extend(p for p in (ROOT / name).rglob('*') if p.is_file()
                     and '__pycache__' not in p.parts and p.suffix != '.pyc' and p.name != '.DS_Store')
    files.extend(ROOT / name for name in ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron-builder.relay.yml', 'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'vitest.config.ts', 'eslint.config.cjs', 'LICENSE', 'NOTICE.md'])
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(files)}


def verify_inputs():
    base = ROOT / 'core-extensions/mihomo-geodata-v1'
    supplement = ROOT / 'core-extensions/mihomo-provider-file-v1'
    manifest = read_json(base / 'manifest.json')
    extra = read_json(supplement / 'manifest.json')
    if manifest['upstream']['commit'] != COMMIT or extra['source']['commit'] != COMMIT:
        raise RuntimeError('Unexpected source revision')
    if digest(base / 'manifest.json') != extra['requires']['manifestSHA256']:
        raise RuntimeError('Base extension manifest changed')
    handoff = ROOT / 'core-extensions/mihomo-tun-handoff'
    for directory in [base, supplement, handoff]:
        plain_tree(directory)
    if digest(base / 'upstream-source-files.json') != manifest['upstream']['sourceInventorySHA256']:
        raise RuntimeError('Source inventory changed')
    for name, pin in manifest['overlays'].items():
        if digest(base / 'overlay' / name) != pin['sha256']:
            raise RuntimeError('Geodata overlay changed: ' + name)
    for name, pin in extra['overlays'].items():
        if digest(supplement / pin['path']) != pin['sha256']:
            raise RuntimeError('Provider overlay changed: ' + name)
    if digest(supplement / extra['patch']['path']) != extra['patch']['sha256']:
        raise RuntimeError('Provider patch changed')
    core = read_json(ROOT / 'src/main/relay/core/geodata-manifest.json')
    if digest(base / 'patches/0001-local-geodata-v1.patch') != core['source']['patchSHA256']:
        raise RuntimeError('Geodata patch changed')
    for path in [ROOT / 'native/guard/terminal/package/manifest.json', ROOT / 'native/guard/package/cli-manifest.json']:
        if read_json(path).get('runtimeReady') is not False:
            raise RuntimeError('This release recipe supports the unsigned self-use feature set only')
    handoff_manifest = read_json(handoff / 'manifest.json')
    handoff_pin = core['source']['darwinTunHandoff']
    if handoff_manifest['commit'] != COMMIT or digest(handoff / 'manifest.json') != handoff_pin['manifestSHA256']:
        raise RuntimeError('Unexpected Darwin TUN handoff manifest')
    if digest(handoff / 'patches/0003-darwin-tun-handoff.patch') != handoff_manifest['patchSHA256'] or handoff_manifest['patchSHA256'] != handoff_pin['patchSHA256']:
        raise RuntimeError('Darwin TUN handoff patch changed')
    for name, pin in handoff_manifest['overlays'].items():
        if digest(handoff / 'overlay' / name) != pin['sha256']:
            raise RuntimeError('Darwin TUN handoff overlay changed: ' + name)
    return manifest, extra, handoff_manifest


def prerequisites():
    if platform.system() != 'Darwin' or os.geteuid() == 0:
        raise RuntimeError('Build on macOS as an ordinary user')
    for executable in ['node', 'pnpm', 'python3', 'go', 'xcrun', 'codesign', 'lipo']:
        if not shutil.which(executable):
            raise RuntimeError('Missing prerequisite: ' + executable)
    if not output('node', '--version').startswith('v24.'):
        raise RuntimeError('Use Node 24 LTS')
    if output('pnpm', '--version') != read_json(ROOT / 'package.json')['packageManager'].split('@')[1]:
        raise RuntimeError('Use the pnpm version in package.json')


def fetch_source(manifest):
    archive = WORK / 'mihomo-source.tar.gz'
    source = WORK / ('mihomo-' + COMMIT)
    run('/usr/bin/curl', '--fail', '--location', '--proto', '=https', '--tlsv1.2',
        '--max-time', '180', '--output', archive,
        'https://codeload.github.com/MetaCubeX/mihomo/tar.gz/' + COMMIT)
    if digest(archive) != manifest['upstream']['archiveSHA256']:
        raise RuntimeError('Mihomo source archive digest mismatch')
    with tarfile.open(archive, 'r:gz') as tar:
        prefix = 'mihomo-' + COMMIT
        for member in tar.getmembers():
            target = (WORK / member.name).resolve()
            if not target.is_relative_to(WORK / prefix) or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unsafe source archive member')
        tar.extractall(WORK)
    verify_source_tree(source)
    return source


def verify_source_tree(source):
    expected = read_json(ROOT / 'core-extensions/mihomo-geodata-v1/upstream-source-files.json')
    expected = expected.get('files', expected)
    plain_tree(source)
    actual = {str(p.relative_to(source)): digest(p) for p in source.rglob('*') if p.is_file()}
    pins = {name: pin if isinstance(pin, str) else pin['sha256'] for name, pin in expected.items()}
    if actual != pins:
        raise RuntimeError('Extracted source differs from fixed source inventory')


def verify_core_tun_stacks(binary):
    metadata = output('go', 'version', '-m', binary)
    tags = re.search(r'^\s*build\s+-tags=(\S+)$', metadata, re.MULTILINE)
    if not tags or not {'relay_local_geodata', 'with_gvisor'}.issubset(tags.group(1).split(',')) or not re.search(
            r'^\s*dep\s+github.com/metacubex/gvisor\s+', metadata, re.MULTILINE):
        raise RuntimeError('Core is missing the Mixed/gVisor TUN stack; rebuild with with_gvisor')


def compile_core(source, manifest, extra, handoff):
    # Go overlay leaves upstream source untouched. The reviewed patches are represented.
    replacements = {}
    for extension, entries in [('mihomo-geodata-v1', manifest['overlays']), ('mihomo-provider-file-v1', extra['overlays']),
                               ('mihomo-tun-handoff', handoff['overlays'])]:
        for name in entries:
            replacements[str(source / name)] = str(ROOT / 'core-extensions' / extension / 'overlay' / name)
    for name, pin in handoff['overlays'].items():
        path = source / name
        if (digest(path) if path.exists() else None) != pin['upstreamSHA256']:
            raise RuntimeError('Darwin TUN handoff base differs: ' + name)
    overlay = WORK / 'overlay.json'
    overlay.write_text(json.dumps({'Replace': replacements}, indent=2) + '\n')
    env = {**os.environ, 'GOENV': 'off', 'GOTOOLCHAIN': 'local', 'GOTELEMETRY': 'off',
           'CGO_ENABLED': '0', 'GOOS': 'darwin', 'GOAMD64': 'v1', 'GOARM64': 'v8.0',
           'GOFLAGS': '-mod=readonly', 'GOPATH': str(WORK / 'gopath'),
           'GOCACHE': str(WORK / 'gocache'), 'GOMODCACHE': str(WORK / 'gomodcache'),
           'GOPROXY': 'https://proxy.golang.org', 'GOSUMDB': 'sum.golang.org',
           'GOPRIVATE': '', 'GONOPROXY': '', 'GONOSUMDB': '', 'GOVCS': '*:off'}
    run('go', 'mod', 'download', cwd=source, env=env)
    env['GOPROXY'] = 'off'
    old = read_json(ROOT / 'src/main/relay/core/geodata-manifest.json')
    updated = json.loads(json.dumps(old))
    destination = RESOURCE / 'core-geodata-v1'
    for arch, go_arch in [('arm64', 'arm64'), ('x64', 'amd64')]:
        binary = destination / 'darwin-{}'.format(arch) / 'mihomo'
        binary.parent.mkdir(parents=True)
        run('go', 'build', '-trimpath', '-buildvcs=false', '-overlay', overlay,
            '-tags', 'relay_local_geodata,with_gvisor', '-ldflags',
            '-X github.com/metacubex/mihomo/constant.Version=' + VERSION,
            '-o', binary, '.', cwd=source, env={**env, 'GOARCH': go_arch})
        verify_core_tun_stacks(binary)
        run('/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', binary)
        run('/usr/bin/codesign', '--verify', '--strict', binary)
        raw = binary.read_bytes()
        if int.from_bytes(raw[:4], 'little') != 0xfeedfacf or int.from_bytes(raw[4:8], 'little') != old['assets'][arch]['cpuType']:
            raise RuntimeError('Unexpected Core Mach-O architecture')
        updated['assets'][arch].update(sha256=digest(binary), size=len(raw))
    # These pins are part of the corresponding source for the newly built bytes.
    # Never silently accept an arbitrary binary or weaken the runtime hash verifier.
    for relative in NATIVE_PINS:
        path = ROOT / relative
        contents = path.read_text()
        for arch in ['arm64', 'x64']:
            previous, current = old['assets'][arch], updated['assets'][arch]
            contents = contents.replace(previous['sha256'], current['sha256'])
            contents = re.sub(r'\b' + str(previous['size']) + r'\b', str(current['size']), contents)
        path.write_text(contents)
    (ROOT / 'src/main/relay/core/geodata-manifest.json').write_text(json.dumps(updated, indent=2) + '\n')
    (destination / 'manifest.json').write_text(json.dumps(updated, indent=2) + '\n')
    for relative, name in [('mihomo-geodata-v1/LICENSE.upstream', 'LICENSE'),
                           ('mihomo-geodata-v1/patches/0001-local-geodata-v1.patch', '0001-local-geodata-v1.patch'),
                           ('mihomo-provider-file-v1/patches/0001-serialize-local-file-updates.patch', '0002-serialize-local-file-updates.patch'),
                           ('mihomo-tun-handoff/patches/0003-darwin-tun-handoff.patch', '0003-darwin-tun-handoff.patch')]:
        shutil.copyfile(ROOT / 'core-extensions' / relative, destination / name)
    shutil.copyfile(ROOT / 'core-extensions/SOURCE.md', destination / 'SOURCE.md')


def build_tun_resources():
    directory = ROOT / 'src/main/relay/tun'
    env = {**os.environ, 'RELAY_TUN_HELPER_BUILD_DIR': str(WORK / 'tun-helper')}
    # Regenerate all previously admitted capabilities, keeping unadmitted ones disabled.
    for variable, filename in [('EXECUTION', 'execution-client.json'),
                               ('SMART_TOOLS', 'runtime-smart-tools-client.json'),
                               ('TELEMETRY', 'runtime-telemetry-client.json'),
                               ('HISTORY', 'runtime-history-client.json')]:
        env.pop('RELAY_TUN_' + variable + '_PIN_OUTPUT', None)
        if read_json(directory / filename).get('clientSHA256') is not None:
            env['RELAY_TUN_' + variable + '_PIN_OUTPUT'] = str(directory / filename)
    for variable, filename in [('CAPTURE', 'runtime-capture-client.json'),
                               ('PROXY_GROUPS', 'proxy-groups-client.json'),
                               ('RULES', 'runtime-rules-client.json'),
                               ('RESOURCES', 'runtime-resources-client.json'),
                               ('PROVIDERS', 'runtime-rule-providers-client.json')]:
        env['RELAY_TUN_' + variable + '_PIN_OUTPUT'] = str(directory / filename)
    run('zsh', 'scripts/relay/build-tun-helper.zsh', env=env)
    work_directory = directory / 'runtime-work-directory-client.json'
    work_pin = read_json(work_directory)
    if work_pin.get('clientSHA256') is not None:
        # RelayTunAppSession/RelayTunAppBundle implement the existing work-directory proof.
        work_pin['clientSHA256'] = digest(WORK / 'tun-helper/RelayTunClient')
        work_directory.write_text(json.dumps(work_pin, indent=2) + '\n')
    verify_tun_pairing()


def verify_tun_pairing():
    compiled = WORK / 'tun-helper'
    client_hash = digest(compiled / 'RelayTunClient')
    source_receipt = read_json(compiled / 'shipping-sources.json')
    for name, sha in source_receipt['files'].items():
        if digest(ROOT / name) != sha:
            raise RuntimeError('TUN client source changed after compilation: ' + name)
    cores = read_json(ROOT / 'src/main/relay/core/geodata-manifest.json')['assets']
    for path in (ROOT / 'src/main/relay/tun').glob('*-client.json'):
        pin = read_json(path)
        if pin.get('clientSHA256') is not None and pin['clientSHA256'] != client_hash:
            raise RuntimeError('TUN capability is paired with a different client: ' + path.name)
        if 'cores' in pin and pin['cores'] != {arch: cores[arch]['sha256'] for arch in ['arm64', 'x64']}:
            raise RuntimeError('TUN capability is paired with a different Core: ' + path.name)
    return {name: digest(compiled / name) for name in ['RelayTunHelper', 'RelayTunClient', 'RelayTunUninstall']}


def resources():
    manifest, extra, handoff = verify_inputs()
    prerequisites()
    if output('go', 'version').split()[2] != manifest['SDK']['version']:
        raise RuntimeError('Use the pinned Go SDK: ' + manifest['SDK']['version'])
    if WORK.exists() or RESOURCE.exists():
        raise RuntimeError('Fresh .relay-build/public and extra/relay required; inspect existing outputs first')
    WORK.mkdir(parents=True)
    RESOURCE.mkdir(parents=True)
    source = fetch_source(manifest)
    compile_core(source, manifest, extra, handoff)
    verify_source_tree(source)
    verify_inputs()
    build_tun_resources()
    frozen_sources = source_inventory()
    run('python3', 'scripts/relay/fetch-core.py')
    run('zsh', 'scripts/relay/build-native.zsh')
    run('zsh', 'scripts/relay/build-network-observer.zsh')
    terminal = RESOURCE / 'guard-terminal'
    terminal.mkdir()
    shutil.copyfile(ROOT / 'native/guard/terminal/package/manifest.json', terminal / 'manifest.json')
    shutil.copyfile(ROOT / 'resources/relay-tray-template.png', RESOURCE / 'tray.png')
    (RESOURCE / 'docs').mkdir()
    shutil.copyfile(ROOT / 'docs/AI-Network-Handoff.md', RESOURCE / 'docs/AI-Network-Handoff.md')
    if source_inventory() != frozen_sources:
        raise RuntimeError('Source changed during Native/resource staging; review and rebuild required')
    # Scope receipt records locally built resources, never an installed or accepted product.
    receipt = {'version': read_json(ROOT / 'package.json')['version'], 'runtimeReady': False,
               'resources': {str(p.relative_to(RESOURCE)): digest(p) for p in RESOURCE.rglob('*') if p.is_file()},
               'sourceInputs': source_inventory(), 'tunResources': verify_tun_pairing(),
               'networkConfigurationChanged': False, 'installed': False}
    (WORK / 'resources.json').write_text(json.dumps(receipt, indent=2) + '\n')


def verify_staged_resources():
    receipt = read_json(WORK / 'resources.json')
    current = {str(p.relative_to(RESOURCE)): digest(p) for p in RESOURCE.rglob('*') if p.is_file()}
    if (receipt['resources'] != current or receipt['version'] != read_json(ROOT / 'package.json')['version']
            or receipt['sourceInputs'] != source_inventory() or receipt['tunResources'] != verify_tun_pairing()):
        raise RuntimeError('Resource/source inputs changed; rebuild/review required')
    return receipt


def app_path(arch):
    return ROOT / 'release/apps.noindex' / ('mac-arm64' if arch == 'arm64' else 'mac') / 'Relay.app'


def app_inventory(app):
    if not app.is_dir() or app.is_symlink():
        raise RuntimeError('Expected a physical packaged App directory')
    return {str(p.relative_to(app)): {'link': os.readlink(p)} if p.is_symlink()
            else {'sha256': digest(p), 'mode': p.stat().st_mode & 0o7777}
            for p in app.rglob('*') if p.is_symlink() or p.is_file()}


def verify_packaged_app(arch):
    resources = verify_staged_resources()
    receipt = read_json(WORK / ('package-' + arch + '.json'))
    if (receipt['architecture'] != arch or receipt['resourceReceiptSHA256'] != digest(WORK / 'resources.json')
            or receipt['version'] != resources['version'] or receipt['app'] != app_inventory(app_path(arch))):
        raise RuntimeError('Packaged App does not match this source/resource build')


def package(arch):
    prerequisites()
    verify_inputs()
    resources = verify_staged_resources()
    run('pnpm', 'run', 'build:relay')
    run('pnpm', 'exec', 'electron-builder', '--config', 'electron-builder.relay.yml',
        '--mac', 'dir', '--' + arch, '--publish', 'never')
    verify_staged_resources()
    receipt = {'architecture': arch, 'version': resources['version'],
               'resourceReceiptSHA256': digest(WORK / 'resources.json'), 'app': app_inventory(app_path(arch))}
    (WORK / ('package-' + arch + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')


def installer(arch):
    prerequisites()
    verify_packaged_app(arch)
    helper = WORK / 'system-proxy-helper'
    # Reuse is limited to the verified helper generated by this public build session.
    if helper.exists():
        receipt = read_json(helper / 'build-receipt.json')
        if (receipt.get('passed') is not True or receipt.get('freshInstallOnly') is not True
                or receipt['packageSHA256'] != digest(helper / 'Relay-System-Proxy-Helper-v1.pkg')):
            raise RuntimeError('Move the prior system-proxy-helper build directory aside and retry; '
                               'this installer requires a fresh verified helper')
        for name, sha in receipt['sourceSHA256'].items():
            if digest(ROOT / name) != sha:
                raise RuntimeError('Current helper source changed')
    else:
        env = {**os.environ, 'RELAY_SYSTEM_PROXY_HELPER_BUILD_DIR': str(helper)}
        env.pop('RELAY_SYSTEM_PROXY_HELPER_REUSE_BUILD_DIR', None)
        run('zsh', 'scripts/relay/build-system-proxy-helper.zsh', env=env)
    verify_packaged_app(arch)
    run('python3', 'scripts/relay/build-integrated-installer.py', '--app', app_path(arch),
        '--helper-build', helper, '--tun-build', WORK / 'tun-helper', '--output', WORK / ('installer-' + arch))


def tun_installer():
    prerequisites()
    verify_staged_resources()
    # Existing managed TUN installer intentionally binds this ordinary build user's UID.
    # It is for that local machine, not a universally distributable package.
    run('python3', 'scripts/relay/build-tun-managed-candidate.py', '--execution-profile', 'local-geodata-v1',
        env={**os.environ, 'RELAY_TUN_HELPER_BUILD_DIR': str(WORK / 'tun-helper')})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['resources', 'package', 'installer', 'tun-installer'], nargs='?', default='resources')
    parser.add_argument('--arch', choices=['arm64', 'x64'], default='arm64')
    parser.add_argument('--dry-run', action='store_true', help='Check source pins and show the plan, without downloads or writes')
    parser.add_argument('--execute', action='store_true', help='Explicitly run the selected build stage')
    args = parser.parse_args()
    verify_inputs()
    if args.dry_run or not args.execute:
        print(json.dumps({'stage': args.stage, 'version': read_json(ROOT / 'package.json')['version'],
                          'architecture': args.arch, 'sourcePinsVerified': True, 'executed': False,
                          'steps': {'resources': ['download fixed Mihomo source and Go modules', 'build both patched cores', 'update corresponding TS/Swift digest pins', 'compile TUN helper/client and regenerate admitted capability pins', 'fetch fixed official cores', 'compile Native, Browser and observer from source', 'stage disabled Guard manifest and notices'],
                                    'package': ['verify staged resource inventory', 'compile renderer/main', 'package requested architecture with ad-hoc signing; never publish'],
                                    'installer': ['verify exact matching App/resource/source receipt', 'build or verify current-session helper and its installer', 'compose requested App and helper; never install'],
                                    'tun-installer': ['verify Core/client/source pairing', 'build same-user local managed TUN package; never install or publish']}[args.stage]}, indent=2))
        return
    os.umask(0o022)
    {'resources': resources, 'package': lambda: package(args.arch), 'installer': lambda: installer(args.arch), 'tun-installer': tun_installer}[args.stage]()


if __name__ == '__main__':
    main()
