#!/usr/bin/env python3
"""Read back a publisher-staged Relay ES/NE pair, without signing or loading it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import struct
import subprocess
import sys
import tempfile


APP_ID = 'local.relay.network.preview'
NE_ID = APP_ID + '.guard'
ES_ID = NE_ID + '.lineage'
NE_EXEC = 'RelayGuardExtension'
ES_EXEC = 'RelayGuardLineageExtension'
NE_CLASS = NE_EXEC + '.RelayGuardFilterDataProvider'
CPU = {'arm64': 0x100000C, 'x86_64': 0x1000007}
EXTENSION_DIR = Path('Contents/Library/SystemExtensions')
RELAY_RESOURCES = Path('Contents/Resources/relay')
NE_PACKAGE = Path('native/guard/package')
ES_PACKAGE = Path('native/guard/lineage/package')
HOST_ROLES = {'RelayGuard.node': (8, 'node'), 'libRelayGuardHost.dylib': (6, 'swift')}
NE_ENTITLEMENT = 'com.apple.developer.networking.networkextension'
ES_ENTITLEMENT = 'com.apple.developer.endpoint-security.client'
INSTALL_ENTITLEMENT = 'com.apple.developer.system-extension.install'
GROUP_ENTITLEMENT = 'com.apple.security.application-groups'
EARLY_BOOT_ENTITLEMENT = 'com.apple.developer.endpoint-security.early-boot'
MAX_CODE_BYTES = 128 * 1024 * 1024


def require(condition, reason):
    if not condition:
        raise ValueError('Guard extension release pairing refused: ' + reason)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def file_stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class Files:
    """Pin every observed path before external read-only signature inspection."""

    def __init__(self):
        self.observed = {}

    def track(self, path):
        require(path.is_absolute() and path.resolve(strict=True) == path, f'unsafe path: {path}')
        value = path.lstat()
        require(not value.st_mode & 0o022, f'writable by another user: {path}')
        stamp = file_stamp(value)
        require(self.observed.setdefault(path, stamp) == stamp, f'path changed: {path}')
        return value

    def read(self, path, limit):
        before = self.track(path)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= limit,
                f'unsafe file: {path}')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            stamp = file_stamp(before)
            require(file_stamp(os.fstat(stream.fileno())) == stamp, f'file changed: {path}')
            data = stream.read(before.st_size + 1)
            require(len(data) == before.st_size and file_stamp(os.fstat(stream.fileno())) == stamp,
                    f'file changed: {path}')
        self.track(path)
        return data

    def directory(self, path, names):
        require(stat.S_ISDIR(self.track(path).st_mode) and {p.name for p in path.iterdir()} == set(names),
                f'unexpected directory members: {path}')

    def verify(self):
        for path in self.observed:
            self.track(path)

    def tree(self, path):
        require(stat.S_ISDIR(self.track(path).st_mode), f'not a bundle directory: {path}')
        value = {}
        for member in path.rglob('*'):
            mode = self.track(member).st_mode
            digest = None if stat.S_ISDIR(mode) else sha256(self.read(member, MAX_CODE_BYTES))
            value[member.relative_to(path)] = (mode, digest)
            require(len(value) <= 128, f'excess component bundle members: {path}')
        return value


def thin(files, path, architecture, kind):
    value = files.read(path, MAX_CODE_BYTES)
    require(len(value) >= 32, f'truncated Mach-O: {path}')
    require(kind != 2 or files.track(path).st_mode & stat.S_IXUSR, f'executable mode missing: {path}')
    magic, cpu, _, binary_kind = struct.unpack_from('<IIII', value)
    require((magic, cpu, binary_kind) == (0xfeedfacf, CPU[architecture], kind),
            f'wrong Mach-O architecture or role: {path}')
    return value


def compiled_value(source, name, expected):
    matches = re.findall(r'^\s*static let ' + re.escape(name) + r'(?:\s*:\s*String\?)?\s*=\s*(.+)$',
                         source, re.MULTILINE)
    require(matches == [expected], f'compiled {name} differs from the release definition')


def authority(files, path, name):
    text = files.read(path, 16384).decode()
    matches = re.findall(r'^enum ' + name + r' \{\n([\s\S]*?)^\}$', text, re.MULTILINE)
    require(len(matches) == 1 and '/*' not in matches[0], f'ambiguous compiled authority: {name}')
    return matches[0]


def definitions(files, root):
    ne = json.loads(files.read(root / NE_PACKAGE / 'manifest.json', 8192))
    es = json.loads(files.read(root / ES_PACKAGE / 'manifest.json', 8192))
    team = ne.get('publisherTeamID')
    build = ne.get('buildVersion')
    require(isinstance(team, str) and re.fullmatch(r'[A-Z0-9]{10}', team) is not None and
            isinstance(build, str) and re.fullmatch(r'[1-9][0-9]{0,8}', build) is not None,
            'missing approved publisher and build')
    expected = {
        'schemaVersion': 1, 'hostBundleID': APP_ID, 'minimumMacOS': '13.0',
        'shortVersion': '2.0.0', 'buildVersion': build, 'publisherTeamID': team
    }
    # Electron Builder defaults the outer App short version to package.json's
    # version. Extension Info.plists use the numeric release base.
    app_short_version = json.loads(files.read(root / 'package.json', 65536)).get('version')
    version_suffix = r'[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*'
    require(isinstance(app_short_version, str) and re.fullmatch(
        re.escape(expected['shortVersion']) + rf'(?:-{version_suffix})?(?:\+{version_suffix})?', app_short_version
    ) is not None, 'App source version differs from the component release base')
    base_keys = set(expected) | {
        'extensionBundleID', 'bundleName', 'executable', 'moduleName', 'machServiceSuffix',
        'systemInstallationSupported'
    }
    require(set(ne) == base_keys | {'providerClass', 'runtimeProtectionReady'} and
            set(es) == base_keys | {
                'applicationGroupSuffix', 'policyRevision', 'contractRevision', 'catalogRevision',
                'resourceSHA256', 'runtimeMonitoringReady', 'globalCoverageReady'
            }, 'unknown component release manifest schema')
    for value, identifier, executable in [(ne, NE_ID, NE_EXEC), (es, ES_ID, ES_EXEC)]:
        fixed = {**expected, 'extensionBundleID': identifier, 'bundleName': identifier + '.systemextension',
                 'executable': executable, 'moduleName': executable, 'machServiceSuffix': identifier + '.ipc'}
        require(all(value.get(k) == v for k, v in fixed.items()) and type(value['schemaVersion']) is int,
                'component release identity or version mismatch')
    require(ne.get('providerClass') == NE_CLASS and es.get('applicationGroupSuffix') == NE_ID,
            'provider class or application group mismatch')
    release = authority(files, root / 'native/RelayGuardRelease.swift', 'RelayGuardManagementRelease')
    lineage = authority(files, root / 'native/guard/lineage/RelayGuardLineageRelease.swift',
                        'RelayGuardLineageRelease')
    compiled_value(release, 'publisherTeamID', json.dumps(team))
    compiled_value(release, 'buildVersion', json.dumps(build))
    # The running management gate compares both components' compiled authority.
    for field, kind in [('publisherTeamID', 'String?'), ('buildVersion', 'String')]:
        declarations = re.findall(r'^[ \t]*static[ \t]+(?:let|var)[ \t]+' + field + r'\b[^\r\n]*',
                                  lineage, re.MULTILINE)
        expected_alias = f'static var {field}: {kind} {{ RelayGuardManagementRelease.{field} }}'
        require([declaration.strip() for declaration in declarations] == [expected_alias],
                f'compiled lineage {field} must inherit the Guard release authority')
    for key in ['policyRevision', 'contractRevision', 'catalogRevision']:
        value = es.get(key)
        require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9.-]{1,96}', value) is not None,
                f'invalid {key}')
        compiled_value(release if key == 'policyRevision' else lineage, key, json.dumps(value))
    for source, manifest, keys in [
        (release, ne, ['systemInstallationSupported', 'runtimeProtectionReady']),
        (lineage, es, ['systemInstallationSupported', 'runtimeMonitoringReady', 'globalCoverageReady'])
    ]:
        for key in keys:
            require(type(manifest.get(key)) is bool, f'invalid {key}')
            compiled_value(source, key, json.dumps(manifest[key]))
    require(ne['systemInstallationSupported'] == es['systemInstallationSupported'],
            'unequal component installation gates')
    pins = es.get('resourceSHA256')
    require(isinstance(pins, dict) and set(pins) == set(CPU) and
            all(isinstance(pin, str) and re.fullmatch(r'[a-f0-9]{64}', pin) is not None for pin in pins.values()),
            'missing signed ES binary pins')
    return team, build, app_short_version, pins


def component_info(path, files, identifier, executable, team, build):
    value = plistlib.loads(files.read(path, 65536))
    expected = {'CFBundleIdentifier': identifier, 'CFBundleName': executable, 'CFBundleExecutable': executable,
                'CFBundlePackageType': 'SYSX', 'CFBundleShortVersionString': '2.0.0',
                'CFBundleVersion': build, 'LSMinimumSystemVersion': '13.0'}
    require(all(value.get(key) == item for key, item in expected.items()), f'component Info mismatch: {identifier}')
    mach = team + '.' + identifier + '.ipc'
    if identifier == NE_ID:
        require(value.get('NetworkExtension') == {
            'NEMachServiceName': mach,
            'NEProviderClasses': {'com.apple.networkextension.filter-data': NE_CLASS}
        } and 'NSEndpointSecurityMachServiceName' not in value, 'NE Mach or provider class mismatch')
    else:
        require(value.get('NSEndpointSecurityMachServiceName') == mach and 'NetworkExtension' not in value,
                'ES Mach or provider role mismatch')
    require(isinstance(value.get('NSSystemExtensionUsageDescription'), str) and
            value['NSSystemExtensionUsageDescription'].strip(), 'missing SystemExtensions purpose text')


def signed_entitlements(path, architecture):
    result = subprocess.run(
        ['/usr/bin/codesign', '--display', '--architecture', architecture, '--entitlements', ':-', str(path)],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
    )
    return plistlib.loads(result.stdout)


def verify_signatures(request):
    with tempfile.TemporaryDirectory(prefix='relay-guard-pair-signature-') as scratch:
        verifier = Path(__file__).resolve().with_name('verify-guard-signatures.swift')
        subprocess.run(
            ['/usr/bin/xcrun', '--sdk', 'macosx', 'swift', '-module-cache-path', scratch, str(verifier)],
            input=json.dumps(request).encode(), check=True, timeout=120,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TMPDIR': scratch}
        )


def expected_entitlements(team, role):
    expected = {GROUP_ENTITLEMENT: [team + '.' + NE_ID]}
    if role in ('app', 'filter'):
        expected[NE_ENTITLEMENT] = ['content-filter-provider-systemextension']
    if role == 'app':
        expected[INSTALL_ENTITLEMENT] = True
    if role == 'filter':
        expected['com.apple.security.app-sandbox'] = True
    if role == 'lineage':
        expected[ES_ENTITLEMENT] = True
    return expected


def check_entitlements(actual, team, role):
    expected = expected_entitlements(team, role)
    forbidden = {NE_ENTITLEMENT, ES_ENTITLEMENT, INSTALL_ENTITLEMENT, EARLY_BOOT_ENTITLEMENT}
    require(isinstance(actual, dict) and not forbidden.difference(expected).intersection(actual) and
            all(actual.get(key) is value if type(value) is bool else actual.get(key) == value
                for key, value in expected.items()), f'wrong signed capabilities for {role}')


def verify_entitlements(path, architecture, team, role, inspect):
    check_entitlements(inspect(path, architecture), team, role)


def app_target(app, architecture, files, build, app_short_version):
    require(architecture in CPU and app.name == 'Relay.app', 'unexpected App path or architecture')
    files.track(app)
    info = plistlib.loads(files.read(app / 'Contents/Info.plist', 65536))
    require(all(info.get(key) == value for key, value in {
        'CFBundleIdentifier': APP_ID, 'CFBundleExecutable': 'Relay', 'CFBundleVersion': build,
        'CFBundleShortVersionString': app_short_version, 'LSMinimumSystemVersion': '13.0'
    }.items()), 'App Info mismatch')
    thin(files, app / 'Contents/MacOS/Relay', architecture, 2)
    return {'path': str(app), 'identifier': APP_ID, 'architectures': [architecture],
            'appVersion': {'build': build, 'short': app_short_version}}


def bundle_inputs(app, source, staged_components, architecture):
    files = Files()
    team, build, app_short_version, pins = definitions(files, source)
    targets = [app_target(app, architecture, files, build, app_short_version)]
    purpose = plistlib.loads(files.read(app / 'Contents/Info.plist', 65536)).get('NSSystemExtensionUsageDescription')
    require(isinstance(purpose, str) and purpose.strip(), 'missing App SystemExtensions purpose text')
    components = {}
    names = [identifier + '.systemextension' for identifier in [NE_ID, ES_ID]]
    files.directory(staged_components, names)
    files.directory(app / EXTENSION_DIR, names)
    for identifier, executable in [(NE_ID, NE_EXEC), (ES_ID, ES_EXEC)]:
        bundle = app / EXTENSION_DIR / (identifier + '.systemextension')
        approved = staged_components / bundle.name
        require(files.tree(bundle) == files.tree(approved), f'component signed tree changed: {identifier}')
        info_path = Path('Contents/Info.plist')
        code_path = Path('Contents/MacOS') / executable
        component_info(bundle / info_path, files, identifier, executable, team, build)
        digest = sha256(thin(files, bundle / code_path, architecture, 2))
        if identifier == ES_ID:
            require(digest == pins[architecture], 'ES binary pin mismatch')
        targets.append({'path': str(bundle), 'identifier': identifier, 'architectures': [architecture]})
        components[identifier] = digest

    hosts = {}
    stage = source / 'extra/relay'
    for arch in CPU:
        relative = Path('guard-host') / arch
        host = app / RELAY_RESOURCES / relative
        files.directory(host, ['manifest.json', *HOST_ROLES])
        manifest = files.read(host / 'manifest.json', 8192)
        require(manifest == files.read(stage / relative / 'manifest.json', 8192), 'Guard host manifest changed')
        value = json.loads(manifest)
        require(isinstance(value, dict) and set(value) == {'version', 'architecture', 'buildVersion', 'files'}
                and type(value['version']) is int and value['version'] == 1 and value['architecture'] == arch
                and value['buildVersion'] == build and isinstance(value['files'], dict)
                and set(value['files']) == set(HOST_ROLES), 'Guard host manifest identity mismatch')
        for name, (kind, suffix) in HOST_ROLES.items():
            digest = sha256(thin(files, host / name, arch, kind))
            require(digest == value['files'][name] == sha256(thin(files, stage / relative / name, arch, kind)),
                    'Guard host signed resource pin mismatch')
            targets.append({'path': str(host / name), 'identifier': APP_ID + '.guard-host.' + suffix,
                            'architectures': [arch]})
        hosts[arch] = value['files']

    native = app / RELAY_RESOURCES / 'RelayNative'
    require(files.track(native).st_mode & stat.S_IXUSR and
            files.read(native, MAX_CODE_BYTES) == files.read(stage / 'RelayNative', MAX_CODE_BYTES),
            'RelayNative signed bytes changed')
    targets.append({'path': str(native), 'identifier': 'RelayNative', 'architectures': list(CPU)})
    return files, team, build, targets, components, hosts


def verify_bundle(app, source, staged_components, architecture, inspect=verify_signatures,
                  inspect_entitlements=signed_entitlements):
    files, team, build, targets, components, hosts = bundle_inputs(app, source, staged_components, architecture)
    inspect({'team': team, 'targets': targets})
    verify_entitlements(app, architecture, team, 'app', inspect_entitlements)
    verify_entitlements(app / EXTENSION_DIR / (NE_ID + '.systemextension'), architecture, team, 'filter', inspect_entitlements)
    verify_entitlements(app / EXTENSION_DIR / (ES_ID + '.systemextension'), architecture, team, 'lineage', inspect_entitlements)
    files.verify()
    return {'offlineDeveloperIDPairingVerified': True, 'team': team, 'buildVersion': build,
            'architecture': architecture, 'extensionSHA256': components, 'guardHostSHA256': hosts,
            'provisioningOrNotarizationVerified': False, 'runtimeProtectionVerified': False,
            'activationAttempted': False, 'appLaunched': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--signed-components', required=True, type=Path)
    parser.add_argument('--architecture', required=True, choices=CPU)
    args = parser.parse_args()
    require(sys.platform == 'darwin', 'macOS Security.framework is required')
    print(json.dumps(verify_bundle(args.app, args.source_root, args.signed_components, args.architecture), indent=2))


if __name__ == '__main__':
    main()
