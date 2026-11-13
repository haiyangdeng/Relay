#!/usr/bin/env python3
"""Build and inspect ad-hoc development candidates; never execute or install them."""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import plistlib
import re
import struct
import subprocess
import sys
import tempfile
from guard_source_plan import provider_sources, reused_observers, lineage_audit_header

APP = Path(__file__).resolve().parents[2]
PACKAGE = APP / 'native/guard/package'
POINT = 'com.apple.networkextension.filter-data'
CAPABILITY = 'content-filter-provider-systemextension'
NE_KEY = 'com.apple.developer.networking.networkextension'
TEAM_TOKEN = '__RELAY_PUBLISHER_TEAM_ID__'


def validate_definition(manifest, info, extension, host):
    expected = {
        'schemaVersion': 1, 'hostBundleID': 'local.relay.network.preview',
        'extensionBundleID': 'local.relay.network.preview.guard',
        'bundleName': 'local.relay.network.preview.guard.systemextension',
        'executable': 'RelayGuardExtension', 'moduleName': 'RelayGuardExtension',
        'providerClass': 'RelayGuardExtension.RelayGuardFilterDataProvider',
        'machServiceSuffix': 'local.relay.network.preview.guard.ipc',
        'minimumMacOS': '13.0', 'shortVersion': '2.0.0', 'buildVersion': '3',
        'publisherTeamID': None, 'runtimeProtectionReady': False,
        'systemInstallationSupported': False,
    }
    if manifest != expected or any(type(manifest.get(key)) is not type(value) for key, value in expected.items()):
        raise ValueError('The reviewed development-only package definition changed.')
    required_info = {
        'CFBundleIdentifier': manifest['extensionBundleID'],
        'CFBundleName': manifest['executable'], 'CFBundleExecutable': manifest['executable'],
        'CFBundlePackageType': 'SYSX', 'CFBundleShortVersionString': manifest['shortVersion'],
        'CFBundleVersion': manifest['buildVersion'], 'LSMinimumSystemVersion': manifest['minimumMacOS'],
        'NetworkExtension': {
            'NEMachServiceName': TEAM_TOKEN + '.' + manifest['machServiceSuffix'],
            'NEProviderClasses': {POINT: manifest['providerClass']},
        },
    }
    if set(info) != set(required_info) | {'NSSystemExtensionUsageDescription'}:
        raise ValueError('Unexpected system-extension metadata.')
    if any(info[key] != value for key, value in required_info.items()):
        raise ValueError('Bundle, provider, version or Mach identity mismatch.')
    if not isinstance(info['NSSystemExtensionUsageDescription'], str) or not info['NSSystemExtensionUsageDescription'].strip():
        raise ValueError('A truthful usage description is required.')
    if extension != {'com.apple.security.app-sandbox': True, NE_KEY: [CAPABILITY], 'com.apple.security.application-groups': [TEAM_TOKEN + '.local.relay.network.preview.guard']} or extension.get('com.apple.security.app-sandbox') is not True:
        raise ValueError('Unexpected extension entitlement or provider capability.')
    if host != {'com.apple.developer.system-extension.install': True, NE_KEY: [CAPABILITY], 'com.apple.security.application-groups': [TEAM_TOKEN + '.local.relay.network.preview.guard']} or host.get('com.apple.developer.system-extension.install') is not True:
        raise ValueError('Unexpected host entitlement or provider capability.')


def definition():
    manifest = json.loads((PACKAGE / 'manifest.json').read_text())
    release = (APP / 'native/RelayGuardRelease.swift').read_text()
    if 'static let buildVersion = ' + json.dumps(manifest['buildVersion']) not in release or 'sessionContractRevision = "relay-guard-session-v2"' not in release or 'policyRevision = "relay-guard-policy-20261109-v3"' not in release:
        raise ValueError('Compiled Guard build/runtime contract does not match packaged metadata.')
    info, extension, host = [plistlib.loads((PACKAGE / name).read_bytes()) for name in
                             ['Info.plist', 'Extension.entitlements.plist', 'Host.entitlements.plist']]
    validate_definition(manifest, info, extension, host)
    builder = (APP / 'electron-builder.relay.yml').read_text()
    app_id = re.search(r'^appId:\s*(\S+)\s*$', builder, re.M)
    build = re.search(r"^buildVersion:\s*['\"]?(\d+)['\"]?\s*$", builder, re.M)
    version = json.loads((APP / 'package.json').read_text())['version'].split('-')[0]
    if not app_id or app_id.group(1) != manifest['hostBundleID'] or not build or build.group(1) != manifest['buildVersion'] or version != manifest['shortVersion']:
        raise ValueError('The package does not match the current Relay host definition.')
    return manifest, info, extension, host


def run(command):
    result = subprocess.run(command, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).decode('utf-8', 'replace')[-8000:])
    return result


def verify_candidate(bundle, manifest, architecture, entitlements):
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    if info['CFBundleIdentifier'] != manifest['extensionBundleID'] or info['CFBundleExecutable'] != manifest['executable'] or info['NetworkExtension'] != {
        'NEMachServiceName': 'unsigned.' + manifest['machServiceSuffix'],
        'NEProviderClasses': {POINT: manifest['providerClass']},
    }:
        raise ValueError('Candidate identity changed after assembly.')
    executable = bundle / 'Contents/MacOS' / manifest['executable']
    data = executable.read_bytes()
    expected_cpu = 0x100000C if architecture == 'arm64' else 0x1000007
    if len(data) < 32 or struct.unpack('<II', data[:8]) != (0xFEEDFACF, expected_cpu):
        raise ValueError('Candidate Mach-O architecture mismatch.')
    run(['/usr/bin/codesign', '--verify', '--strict', str(bundle)])
    signature = run(['/usr/bin/codesign', '-d', '--verbose=4', str(bundle)]).stderr.decode()
    if 'Signature=adhoc' not in signature or 'TeamIdentifier=not set' not in signature or '\nIdentifier=' + manifest['extensionBundleID'] + '\n' not in signature:
        raise ValueError('Development signature must not claim a publisher identity.')
    signed_entitlements = plistlib.loads(run(['/usr/bin/codesign', '-d', '--entitlements', ':-', str(bundle)]).stdout)
    if signed_entitlements != entitlements:
        raise ValueError('Signed entitlements do not match the reviewed candidate.')
    return {'architecture': architecture, 'executableBytes': len(data),
            'executableSHA256': hashlib.sha256(data).hexdigest(),
            'bundlePath': str(bundle), 'adHocSignatureVerified': True,
            'productionSigningVerified': False, 'executableInvoked': False}


def build_candidates():
    if sys.platform != 'darwin':
        raise RuntimeError('Development package compilation requires macOS.')
    manifest, info, entitlements, host_additions = definition()
    build_root = APP / '.relay-build'
    build_root.mkdir(exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='guard-package-', dir=build_root))
    output.chmod(0o700)
    reuse = reused_observers(APP, output)
    sources = provider_sources(APP, APP, output, reuse)
    audit_header = lineage_audit_header(APP, APP)
    tracked = sources + [PACKAGE / name for name in ['manifest.json', 'Info.plist', 'Extension.entitlements.plist', 'Host.entitlements.plist']]
    tracked.append(audit_header)
    tracked += [APP / name for name in ['package.json', 'electron-builder.relay.yml', 'build/entitlements.mac.plist']]
    contents = {path: path.read_bytes() for path in tracked}
    hashes = {str(path.relative_to(APP)): hashlib.sha256(data).hexdigest() for path, data in contents.items()}
    base_entitlements = plistlib.loads(contents[APP / 'build/entitlements.mac.plist'])
    if set(base_entitlements) & set(host_additions):
        raise ValueError('Host entitlement additions would overwrite an existing capability.')
    merged = {**base_entitlements, **host_additions}
    (output / 'Host.entitlements.plist').write_bytes(plistlib.dumps(merged))
    (output / 'HostInfo.fragment.plist').write_bytes(plistlib.dumps({
        'NSSystemExtensionUsageDescription': info['NSSystemExtensionUsageDescription']}))
    entitlements = {key: value for key, value in entitlements.items() if key != 'com.apple.security.application-groups'}
    (output / 'CandidateExtension.entitlements.plist').write_bytes(plistlib.dumps(entitlements))
    rows = []
    with tempfile.TemporaryDirectory(prefix='relay-guard-package-', dir='/private/tmp') as scratch:
        scratch = Path(scratch)
        copied = []
        copied_header = scratch / audit_header.name
        copied_header.write_bytes(contents[audit_header])
        for path in sources:
            target = scratch / path.name
            target.write_bytes(contents[path])
            copied.append(str(target))
        for architecture in ['arm64', 'x86_64']:
            bundle = output / architecture / manifest['bundleName']
            binary_dir = bundle / 'Contents/MacOS'
            binary_dir.mkdir(parents=True, mode=0o755)
            candidate_info = copy.deepcopy(info)
            candidate_info['NetworkExtension']['NEMachServiceName'] = 'unsigned.' + manifest['machServiceSuffix']
            (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(candidate_info))
            run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library',
                 '-warnings-as-errors', '-strict-concurrency=complete',
                 '-module-name', manifest['moduleName'], '-target', architecture + '-apple-macosx13.0',
                 '-module-cache-path', str(scratch / ('ModuleCache-' + architecture)),
                 '-import-objc-header', str(copied_header),
                 *copied, '-framework', 'Foundation', '-framework', 'Security',
                 '-framework', 'NetworkExtension', '-framework', 'Network', '-lbsm',
                 '-o', str(binary_dir / manifest['executable'])])
            run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', '--entitlements',
                 str(output / 'CandidateExtension.entitlements.plist'), str(bundle)])
            rows.append(verify_candidate(bundle, manifest, architecture, entitlements))
    if any(hashlib.sha256(path.read_bytes()).hexdigest() != hashes[str(path.relative_to(APP))] for path in tracked):
        raise RuntimeError('A source changed during the build; candidate evidence was not published.')
    return {'createdAt': datetime.now(timezone.utc).isoformat(), 'scope': 'ad-hoc-development-bundles-only',
            'architectures': rows, 'sourceSHA256': hashes, 'outputDirectory': str(output),
            'hostEntitlementsMerged': True, 'hostApplicationModified': False,
            'productionSigningVerified': False, 'runtimeProtectionVerified': False,
            'installationAttempted': False, 'systemFilterPreferencesWritten': False,
            'inUseClashTouched': False, 'batch41Closed': False,
            'publisherResponsibility': 'Production signing, approved entitlements, notarization and deployment. End users do not buy certificates.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate source metadata without compiling.')
    args = parser.parse_args()
    if args.check:
        definition()
        print('Guard package metadata is consistent; no candidate built or installed.')
    else:
        report = build_candidates()
        (APP.parent / 'evidence/guard-package-verification.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ['scope', 'outputDirectory', 'productionSigningVerified', 'runtimeProtectionVerified', 'installationAttempted']}, indent=2))
