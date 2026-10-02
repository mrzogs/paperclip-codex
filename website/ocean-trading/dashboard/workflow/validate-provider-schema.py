"""Offline, hash-pinned validation; unknown URI resolution fails closed."""
import hashlib
import json
from pathlib import Path
import sys
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from provider_schema_formats import format_checker

ROOT = Path(__file__).parent / 'contracts'


def validate(name, value):
    aliases = json.loads((ROOT / 'schema-resolver-v1.json').read_bytes())
    resources = []
    selected = None
    for item in aliases['resources']:
        filename = (ROOT / item['path']).resolve()
        assert filename.is_relative_to(ROOT.resolve())
        raw = filename.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item['sha256']
        schema = json.loads(raw)
        resources.append((item['uri'], Resource.from_contents(schema)))
        if name == item['uri']:
            selected = schema
    assert selected is not None
    registry = Registry().with_resources(resources)
    Draft202012Validator(selected, registry=registry, format_checker=format_checker).validate(value)


if __name__ == '__main__':
    request = json.load(sys.stdin)
    validate(request['schema'], request['value'])
    print('{"status":"PASS","resolution":"OFFLINE_HASH_PINNED"}')
