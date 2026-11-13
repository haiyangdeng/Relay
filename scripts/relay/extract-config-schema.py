"""Generate runtime schemas only from Git-blob-verified fixed core source."""
from pathlib import Path
import hashlib
import json
import re
import sys

app = Path(__file__).resolve().parents[2]
evidence = app.parent / 'evidence'
reference = evidence / 'mihomo-v1.19.33-reference'
tree = {row['path']: row['sha'] for row in json.loads((evidence / 'mihomo-v1.19.33-tree.json').read_text())['tree']}
sources = {}


def read(path):
    raw = (reference / path.replace('/', '-')).read_bytes()
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if blob != tree[path]:
        raise ValueError('Fixed source mismatch: ' + path)
    sources[path] = blob
    return raw.decode()


def extract(paths, tag):
    result = {}
    for path in paths:
        text = read(path)
        for match in re.finditer(r'type (\w+) struct\s*\{([\s\S]*?)(?:\n\}|\})', text):
            fields, embedded = {}, []
            for line in match[2].splitlines():
                field = re.match(r'\s*(\w+)\s+(.+?)\s+`' + tag + r':"([^",]+)', line)
                if field:
                    if field[3] != '-':
                        fields[field[3]] = field[2].strip()
                elif tag == 'inbound' and (field := re.fullmatch(r'\s*([A-Z]\w*)\s+([^`]+?)(?:\s+`[^`]*`)?\s*', line)):
                    fields[field[1]] = field[2].strip()
                elif re.fullmatch(r'\s*[A-Za-z]\w*\s*', line):
                    embedded.append(line.strip())
            if fields or embedded or match[1] == 'FallbackOption':
                if match[1] in result:
                    raise ValueError('Duplicate schema: ' + match[1])
                result[match[1]] = {'fields': fields, 'embedded': embedded, 'source': path}
    return result


raw = extract(['config/config.go'], 'yaml')
raw['tunnel'] = extract(['listener/config/tunnel.go'], 'yaml')['tunnel']
inbound_paths = [p for p in sorted(tree) if p.startswith('listener/inbound/') and p.endswith('.go') and not p.endswith('_test.go')]
inbound = extract(inbound_paths, 'inbound')
if not re.search(r'type AuthUsers \[\]AuthUser\b', read('listener/inbound/auth.go')):
    raise ValueError('Unknown AuthUsers alias')
for schema in inbound.values():
    schema['fields'] = {key: ('[]AuthUser' if value == 'AuthUsers' else value) for key, value in schema['fields'].items()}
provider = extract(['adapter/provider/parser.go', 'adapter/provider/override.go', 'rules/provider/parse.go'], 'provider')
groups = extract([p for p in sorted(tree) if p.startswith('adapter/outboundgroup/') and p.endswith('.go') and not p.endswith('_test.go')], 'group')


def cases(text, expression):
    result = {}
    for match in re.finditer(r'case "([^"]+)":([\s\S]*?)(?=\n\tcase |\n\tdefault:)', text):
        found = re.search(expression, match[2])
        if found:
            result[match[1]] = found[1]
    return result


listeners = cases(read('listener/parse.go'), r'(?:&IN\.|IN\.Default)(\w+?)(?:\{|ServerOption\()')
# The Hysteria2 realm branch initializes a named default factory, not a struct literal.
listeners['hysteria2-realm'] = 'Hysteria2RealmOption'
if any(name not in inbound for name in listeners.values()):
    raise ValueError('Unresolved listener branch: ' + repr(listeners))
group_types = cases(read('adapter/outboundgroup/parser.go'), r'opt := (\w+)\{')


def reachable(structs, roots):
    seen, queue = set(roots), list(roots)
    while queue:
        schema = structs[queue.pop()]
        types = schema['embedded'] + [re.sub(r'^(?:\*|\[\]|map\[string\])*', '', kind) for kind in schema['fields'].values()]
        for kind in types:
            if kind in structs and kind not in seen:
                seen.add(kind)
                queue.append(kind)
    return {name: structs[name] for name in sorted(seen)}


families = {'raw': reachable(raw, ['RawConfig', 'tunnel']), 'inbound': reachable(inbound, listeners.values()),
            'provider': reachable(provider, ['proxyProviderSchema', 'ruleProviderSchema']),
            'group': reachable(groups, ['GroupCommonOption', *group_types.values()])}
result = {'version': 'v1.19.33', 'families': families, 'listeners': listeners, 'groups': group_types, 'sources': sources}
output = app / 'src/main/relay/configuration/config-schema.json'
if '--check' in sys.argv:
    if json.loads(output.read_text()) != result:
        raise ValueError('Runtime schema is stale or changed.')
else:
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
leaves = {}
for family, structs in families.items():
    leaves[family] = sorted({re.sub(r'^(?:\*|\[\]|map\[string\])*', '', kind) for schema in structs.values()
                             for kind in schema['fields'].values()} - set(structs))
print(json.dumps({'rootFields': len(families['raw']['RawConfig']['fields']), 'listeners': len(listeners),
                  'structs': sum(map(len, families.values())), 'verifiedSources': len(sources), 'leaves': leaves}))
