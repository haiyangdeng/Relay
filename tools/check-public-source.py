#!/usr/bin/env python3
"""Offline publication preflight. Never prints matched secret values."""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IGNORED = {'.git', 'node_modules', '.relay-build', 'out', 'dist', 'extra', 'release', '__pycache__'}
PRIVATE = {'private', 'evidence', 'credentials', 'recovery'}
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b'),
    'api-key': re.compile(r'\bsk-(?:ant-api\d+-)?[A-Za-z0-9_-]{32,}\b'),
    'aws-key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'developer-home': re.compile(r'/Users/(?!fixture(?:/|\b)|test(?:/|\b)|example(?:/|\b)|user(?:/|\b)|alice(?:/|\b)|bob(?:/|\b)|demo(?:/|\b)|tester(?:/|\b)|someone(?:/|\b)|other(?:/|\b)|shared(?:/|\b)|Shared(?:/|\b))[A-Za-z0-9_.-]+/'),
}

def check() -> int:
    failures: list[dict[str, object]] = []
    count = 0
    for path in sorted(ROOT.rglob('*')):
        relative = path.relative_to(ROOT)
        if relative.parts[0] in IGNORED or any(part in IGNORED or part.startswith('release-') for part in relative.parts[:-1]):
            continue
        if path.is_symlink():
            failures.append({'path': relative.as_posix(), 'type': 'symlink-not-source'})
            continue
        if not path.is_file():
            continue
        count += 1
        if any(part in PRIVATE for part in relative.parts) or path.suffix in {'.pkg', '.dmg', '.p12', '.pfx', '.key'} or path.name == '.env':
            failures.append({'path': relative.as_posix(), 'type': 'private-or-generated-file'})
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for kind, pattern in PATTERNS.items():
                if pattern.search(line):
                    failures.append({'path': relative.as_posix(), 'line': number, 'type': kind})
    try:
        package = json.loads((ROOT / 'package.json').read_text())
        manifest = json.loads((ROOT / 'site/releases.json').read_text())
        if package['version'] != manifest['currentVersion']:
            raise ValueError('version-mismatch')
        if manifest.get('schemaVersion') != 1:
            raise ValueError('release-schema')
        releases = manifest['releases']
        if not isinstance(releases, list) or not releases:
            raise ValueError('release-list')
        if len({release['version'] for release in releases}) != len(releases):
            raise ValueError('duplicate-version')
        if manifest['currentVersion'] not in {release['version'] for release in releases}:
            raise ValueError('current-release-missing')
        repo = manifest.get('repositoryUrl')
        if repo is not None and not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
            raise ValueError('repository-url')
        for release in releases:
            if not re.fullmatch(r'\d+\.\d+\.\d+', release['version']):
                raise ValueError('release-version')
            if release['status'] not in {'pending', 'published'}:
                raise ValueError('release-status')
            if sorted(asset['arch'] for asset in release['assets']) != ['arm64', 'x64']:
                raise ValueError('release-architectures')
            for asset in release['assets']:
                if release['status'] == 'pending':
                    if asset.get('url') or asset.get('sha256'):
                        raise ValueError('pending-release-has-download')
                else:
                    if not repo or not release.get('publishedAt'):
                        raise ValueError('published-release-metadata')
                    expected = repo + '/releases/download/v' + release['version'] + '/'
                    filename = asset.get('filename')
                    if not filename or '/' in filename or '\\' in filename or not asset.get('url', '').startswith(expected) or asset['url'][len(expected):] != filename or not re.fullmatch(r'[A-Za-z0-9._-]+', filename):
                        raise ValueError('asset-url')
                    if not re.fullmatch(r'[a-fA-F0-9]{64}', asset.get('sha256', '')):
                        raise ValueError('asset-checksum')
    except (OSError, ValueError, TypeError, KeyError) as error:
        failures.append({'path': 'site/releases.json', 'type': 'invalid-release-metadata', 'reason': str(error) if isinstance(error, ValueError) else type(error).__name__})
    print(json.dumps({'filesChecked': count, 'findings': failures, 'passed': not failures}, ensure_ascii=False, indent=2))
    print('Pattern checks do not replace manual privacy, license, asset provenance or binary verification.')
    return 1 if failures else 0

if __name__ == '__main__':
    sys.exit(check())
