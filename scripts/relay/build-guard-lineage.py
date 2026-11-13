#!/usr/bin/env python3
"""Validate ES source metadata; explicitly typecheck or emit raw candidates.

The default action reads metadata only. No action signs, executes, installs or
activates an extension, queries running processes, or edits a system preference.
Optional ES resources are not copied into the ordinary App by this script.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import struct
import subprocess

from guard_source_plan import resolve, lineage_sources, lineage_audit_header

APP = Path(__file__).resolve().parents[2]
PACKAGE = 'native/guard/lineage/package/'
TEAM_TOKEN = '__RELAY_PUBLISHER_TEAM_ID__'
EXTENSION_ID = 'local.relay.network.preview.guard.lineage'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact(actual, expected):
    return json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True)


def definition(app, source):
    paths = [resolve(app, source, PACKAGE + name) for name in
             ['manifest.json', 'Info.plist', 'Extension.entitlements.plist', 'Host.entitlements.plist']]
    manifest = json.loads(paths[0].read_text())
    expected = {
        'schemaVersion': 1, 'hostBundleID': 'local.relay.network.preview',
        'extensionBundleID': EXTENSION_ID, 'bundleName': EXTENSION_ID + '.systemextension',
        'executable': 'RelayGuardLineageExtension', 'moduleName': 'RelayGuardLineageExtension',
        'machServiceSuffix': EXTENSION_ID + '.ipc',
        'applicationGroupSuffix': 'local.relay.network.preview.guard',
        'minimumMacOS': '13.0', 'shortVersion': '2.0.0', 'buildVersion': '3',
        'contractRevision': 'relay-guard-lineage-v3', 'catalogRevision': 'claude-codex-terminal-cli-roots-v4',
        'policyRevision': 'relay-guard-policy-20261109-v3',
        'publisherTeamID': None, 'resourceSHA256': {'arm64': None, 'x86_64': None},
        'runtimeMonitoringReady': False, 'systemInstallationSupported': False, 'globalCoverageReady': False,
    }
    if not exact(manifest, expected):
        raise ValueError('The reviewed default-off ES source definition changed.')
    info, extension, host = [plistlib.loads(p.read_bytes()) for p in paths[1:]]
    expected_info = {
        'CFBundleIdentifier': EXTENSION_ID, 'CFBundleName': manifest['executable'],
        'CFBundleExecutable': manifest['executable'], 'CFBundlePackageType': 'SYSX',
        'CFBundleShortVersionString': manifest['shortVersion'], 'CFBundleVersion': manifest['buildVersion'],
        'LSMinimumSystemVersion': manifest['minimumMacOS'],
        'NSEndpointSecurityMachServiceName': TEAM_TOKEN + '.' + manifest['machServiceSuffix'],
    }
    description = info.get('NSSystemExtensionUsageDescription')
    if set(info) != set(expected_info) | {'NSSystemExtensionUsageDescription'} or not isinstance(description, str) or not description.strip():
        raise ValueError('Unexpected ES Info keys or absent usage disclosure.')
    if any(info[k] != v for k, v in expected_info.items()):
        raise ValueError('ES executable, build or Mach service identity mismatch.')
    group = [TEAM_TOKEN + '.' + manifest['applicationGroupSuffix']]
    if not exact(extension, {'com.apple.developer.endpoint-security.client': True, 'com.apple.security.application-groups': group}):
        raise ValueError('Unexpected ES entitlement; no NE capability or early-boot policy is added.')
    if not exact(host, {'com.apple.developer.system-extension.install': True, 'com.apple.security.application-groups': group}):
        raise ValueError('Unexpected host capability; ES entitlement belongs only to the extension.')
    release_path = resolve(app, source, 'native/guard/lineage/RelayGuardLineageRelease.swift')
    management_path = resolve(app, source, 'native/RelayGuardRelease.swift')
    paths += [release_path, management_path]
    release, management = release_path.read_text(), management_path.read_text()
    for key in ['runtimeMonitoringReady', 'systemInstallationSupported', 'globalCoverageReady']:
        if not re.search(r'static let ' + key + r'\s*=\s*false\b', release):
            raise ValueError('Compiled ES authority must stay disabled: ' + key)
    for key in ['contractRevision', 'catalogRevision']:
        if 'static let ' + key + ' = ' + json.dumps(manifest[key]) not in release:
            raise ValueError('ES wire/catalog metadata mismatch.')
    if 'static let buildVersion = ' + json.dumps(manifest['buildVersion']) not in management or 'publisherTeamID: String? = nil' not in management:
        raise ValueError('Compiled publisher/build authority changed.')
    if 'static let policyRevision = ' + json.dumps(manifest['policyRevision']) not in management:
        raise ValueError('ES policy does not match the compiled Guard policy.')
    if 'static let extensionID = RelayGuardContract.extensionID + ".lineage"' not in release or 'static let executable = ' + json.dumps(manifest['executable']) not in release:
        raise ValueError('Compiled ES resource identity changed.')
    for key in ['runtimeProtectionReady', 'systemInstallationSupported', 'completeClientScopeReady']:
        if not re.search(r'static let ' + key + r'\s*=\s*false\b', management):
            raise ValueError('Guard deployment authority must stay disabled: ' + key)
    if 'static var buildVersion: String { RelayGuardManagementRelease.buildVersion }' not in release or 'static var publisherTeamID: String? { RelayGuardManagementRelease.publisherTeamID }' not in release:
        raise ValueError('ES must reuse the compiled Guard publisher/build authority.')
    builder = resolve(app, source, 'electron-builder.relay.yml')
    package = resolve(app, source, 'package.json')
    paths += [builder, package]
    if not re.search(r'^appId:\s*' + re.escape(manifest['hostBundleID']) + r'\s*$', builder.read_text(), re.M):
        raise ValueError('ES host identity does not match the ordinary App.')
    if not re.search(r'^buildVersion:\s*[\'\"]?' + re.escape(manifest['buildVersion']) + r'[\'\"]?\s*$', builder.read_text(), re.M):
        raise ValueError('ES build does not match the ordinary App.')
    if json.loads(package.read_text())['version'].split('-')[0] != manifest['shortVersion']:
        raise ValueError('ES version does not match the ordinary App.')
    return manifest, info, paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-root', type=Path, default=APP)
    parser.add_argument('--source-root', type=Path, default=APP)
    parser.add_argument('--output', type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check-source', action='store_true', help='Only dual-architecture source typechecking.')
    modes.add_argument('--build', action='store_true', help='Explicitly emit raw, non-deployable development candidates.')
    args = parser.parse_args()
    app, source = args.app_root.resolve(), args.source_root.resolve()
    manifest, info, tracked = definition(app, source)
    if not args.check_source and not args.build:
        print('ES default-off metadata is consistent; no compiler, extension or system API invoked.')
        return
    if args.output is None:
        parser.error('--check-source/--build requires a new private --output directory')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    sources = lineage_sources(app, source, output)
    header = lineage_audit_header(app, source)
    tracked += sources + [header, resolve(app, source, 'scripts/relay/guard_source_plan.py'),
                          resolve(app, source, 'native/RelayGuardReadiness.swift'),
                          resolve(app, source, 'native/tun/RelayTunHelperTrust.swift'), Path(__file__).resolve()]
    before = {str(p): digest(p) for p in tracked}
    sdk = subprocess.check_output(['xcrun', '--show-sdk-path'], text=True, timeout=30).strip()
    records = []
    for arch, cpu in [('arm64', 0x100000C), ('x86_64', 0x1000007)]:
        flags = ['-parse-as-library', '-swift-version', '5', '-warnings-as-errors', '-strict-concurrency=complete',
                 '-target', arch + '-apple-macosx13.0', '-sdk', sdk,
                 '-module-name', manifest['moduleName'], '-module-cache-path', str(output / ('ModuleCache-' + arch)),
                 '-import-objc-header', str(header)]
        command = ['xcrun', 'swiftc'] + ([] if args.build else ['-frontend', '-typecheck']) + flags + [str(p) for p in sources]
        binary = None
        if args.build:
            bundle = output / arch / manifest['bundleName']
            binary = bundle / 'Contents/MacOS' / manifest['executable']
            binary.parent.mkdir(parents=True)
            (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
            command += ['-framework', 'Foundation', '-framework', 'Security', '-lEndpointSecurity', '-lbsm', '-o', str(binary)]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        (output / (arch + '.log')).write_bytes(result.stdout)
        row = {'architecture': arch, 'kind': 'raw-source-build' if args.build else 'source-typecheck', 'exitCode': result.returncode}
        if result.returncode == 0 and binary is not None:
            data = binary.read_bytes()
            if len(data) < 32 or struct.unpack('<II', data[:8]) != (0xFEEDFACF, cpu):
                raise ValueError('Raw ES candidate architecture mismatch.')
            row.update({'candidateSHA256': digest(binary), 'bundlePath': str(bundle)})
        records.append(row)
        if result.returncode:
            break
    if any(digest(Path(p)) != value for p, value in before.items()):
        raise RuntimeError('ES source changed during the check; evidence is not valid.')
    report = {'sourceOnly': not args.build, 'sourceSHA256': before, 'checks': records,
              'publisherTeamID': None, 'releaseResourcePins': manifest['resourceSHA256'],
              'runtimeMonitoringReady': False, 'globalCoverageReady': False,
              'productionSigningVerified': False, 'runtimeProtectionVerified': False,
              'executed': False, 'installed': False, 'systemManagerCalled': False,
              'testsRun': False, 'signingCommandInvoked': False, 'ordinaryAppModified': False}
    (output / 'source-result.json').write_text(json.dumps(report, indent=2) + '\n')
    raise SystemExit(0 if len(records) == 2 and all(x['exitCode'] == 0 for x in records) else 1)


if __name__ == '__main__':
    main()
