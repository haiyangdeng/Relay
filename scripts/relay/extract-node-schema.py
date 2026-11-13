"""Extract only checked-in schemas from SHA-pinned upstream source; no network or execution."""
from pathlib import Path
import hashlib
import json
import re
import sys

app = Path(__file__).resolve().parents[2]
evidence = app.parent / 'evidence'
reference = evidence / 'mihomo-v1.19.33-reference'
tree = {item['path']: item['sha'] for item in json.loads((evidence / 'mihomo-v1.19.33-tree.json').read_text())['tree']}


def read(path):
    raw = (reference / path.replace('/', '-')).read_bytes()
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if blob != tree[path]:
        raise ValueError('Fixed source blob mismatch: ' + path)
    return raw.decode(), blob


structs, sources = {}, {}
for path in sorted(tree):
    if not path.startswith('adapter/outbound/') or not path.endswith('.go') or path.endswith(('_stub.go', '_test.go')):
        continue
    text, blob = read(path)
    sources[path] = blob
    for match in re.finditer(r'type (\w+) struct \{([\s\S]*?)\n\}', text):
        fields, embedded = {}, []
        for line in match[2].splitlines():
            field = re.match(r'\s*(\w+)\s+(.+?)\s+`(?:proxy|obfs):"([^",]+)', line)
            if field and field[3] != '-':
                fields[field[3]] = field[2]
            elif re.fullmatch(r'\s*[A-Za-z]\w*\s*', line):
                embedded.append(line.strip())
        if fields or embedded:
            if match[1] in structs:
                raise ValueError('Duplicate schema: ' + match[1])
            structs[match[1]] = {'fields': fields, 'embedded': embedded, 'source': path}

parser, blob = read('adapter/parser.go')
sources['adapter/parser.go'] = blob
protocols = {}
for match in re.finditer(r'case "([^"]+)":([\s\S]*?)(?=\n\tcase |\n\tdefault:)', parser):
    schema = re.search(r'&outbound\.(\w+)\{', match[2])
    if not schema or schema[1] not in structs:
        raise ValueError('Unresolved proxy parser branch: ' + match[1])
    protocols[match[1]] = schema[1]

reachable = set(protocols.values()) | {'SingMuxOption', 'simpleObfsOption', 'v2rayObfsOption',
                                     'gostObfsOption', 'shadowTLSOption', 'restlsOption',
                                     'jlsOption', 'kcpTunOption'}
queue = list(reachable)
while queue:
    schema = structs[queue.pop()]
    dependencies = schema['embedded'] + [kind.removeprefix('*').removeprefix('[]').removeprefix('*')
                                       for kind in schema['fields'].values()]
    for dependency in dependencies:
        if dependency in structs and dependency not in reachable:
            reachable.add(dependency)
            queue.append(dependency)
structs = {name: schema for name, schema in structs.items() if name in reachable}
for name, schema in structs.items():
    if any(item not in structs for item in schema['embedded']):
        raise ValueError('Missing embedded schema: ' + name)
    for field_type in schema['fields'].values():
        leaf = field_type.removeprefix('*').removeprefix('[]').removeprefix('*')
        if (leaf not in structs and leaf != 'C.DNSPrefer' and not leaf.startswith('map[')
                and not re.fullmatch(r'(?:u?int\d*|float\d+|bool|string|any|interface\{\})', leaf)):
            raise ValueError('Unresolved field type: ' + field_type)

result = {'version': 'v1.19.33', 'protocols': protocols, 'structs': structs, 'sources': sources}
output = app / 'src/main/relay/profiles/node-schema.json'
serialized = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
if '--check' in sys.argv:
    if json.loads(output.read_text()) != result:
        raise ValueError('Node schema is stale or changed.')
else:
    output.write_text(serialized)
print(json.dumps({'protocols': len(protocols), 'structs': len(structs), 'verifiedSources': len(sources)}))
