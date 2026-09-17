"""Resolve exact observed fields from independently sealed owner exports."""
import importlib.util
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import sys
import zipfile
from jsonschema import Draft202012Validator

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('setup_verifier', ROOT / 'verify-setup-bundle.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
qualification_spec = importlib.util.spec_from_file_location('qualification_verifier', ROOT / 'verify-factual-qualification.py')
qualification = importlib.util.module_from_spec(qualification_spec)
qualification_spec.loader.exec_module(qualification)


def pointer(document, value):
    assert isinstance(value, str) and value.startswith('/') and len(value) < 1000
    for segment in value[1:].split('/'):
        key = segment.replace('~1', '/').replace('~0', '~')
        document = document[int(key)] if isinstance(document, list) else document[key]
    return document


def verify(request):
    assert set(request) == {'instance', 'strategy_code_hash', 'profile_hash', 'source_observed_at_utc', 'bundles', 'proofs'}
    schema = json.loads((ROOT / 'contracts/2.1.0/shared-contracts/shared-contracts.schema.json').read_bytes())
    schema['$ref'] = '#/$defs/executionInstance'
    Draft202012Validator(schema).validate(request['instance'])
    instance = request['instance']
    assert all(re.fullmatch(r'sha256:[a-f0-9]{64}',request[k]) for k in ['strategy_code_hash','profile_hash'])
    observed=datetime.fromisoformat(request['source_observed_at_utc'].replace('Z','+00:00'))
    assert observed.tzinfo is not None and observed<=datetime.now(timezone.utc)
    assert instance['status'] == 'DRAFT' and instance['lease_run_id'] is None
    assert instance['capabilities'] and set(instance['capabilities']) <= {'REPLAY', 'PAPER_FORWARD'}
    assert not any(str(instance[k]).startswith('test-') for k in ['execution_instance_id', 'source_installation_id', 'telemetry_producer_id'])
    assert len(request['bundles']) == 2
    checked = {}
    for role in ['source', 'strategy']:
        item = request['bundles'][role]
        qualification.validate(item, 'reference')
        is_qualification = item.get('schema_version') == 'ocean-factual-qualification-reference/v1'
        result = qualification.verify(item, role) if is_qualification else verifier.verify(item)
        receipt = result['receipt']
        assert receipt.get('status') in ('PASS', 'VERIFIED_REUSE')
        allowed = ['Telemetry Data Logger', 'Telemetry Logger'] if role == 'source' else ['VWAP Strategy']
        assert receipt.get('project', receipt.get('owner')) in allowed
        if is_qualification:
            assert receipt['target_execution_instance_id'] == instance['execution_instance_id']
        checked[role] = result
    fields = {f'instance.{k}': 'source' for k in instance if k not in ['status', 'lease_run_id', 'strategy_id', 'version_binding', 'config_hash']}
    fields.update({'instance.strategy_id': 'strategy', 'instance.version_binding': 'strategy', 'instance.config_hash': 'strategy', 'strategy_code_hash': 'strategy', 'profile_hash': 'strategy', 'source_observed_at_utc': 'source'})
    assert set(request['proofs']) == set(fields)
    for field, role in fields.items():
        proof = request['proofs'][field]
        assert set(proof) == {'member', 'pointer'}
        assert proof['member'] in checked[role]['verified_members'] and proof['member'].startswith('artifacts/')
        with zipfile.ZipFile(request['bundles'][role]['bundle_path']) as archive:
            raw = archive.read(proof['member'])
        assert len(raw) <= 2 * 1024 * 1024
        assert hashlib.sha256(raw).hexdigest() == checked[role]['verified_members'][proof['member']]
        actual = pointer(json.loads(raw), proof['pointer'])
        expected = instance[field.split('.')[1]] if field.startswith('instance.') else request[field]
        assert expected is not None and expected != '' and actual == expected
        if 'facts' in checked[role]:
            assert proof == {'member': 'artifacts/facts.json', 'pointer': '/' + field}
            assert checked[role]['facts'][field] == expected
    return {**request, 'schema_version': 'ocean-operational-factual-binding/v1', 'strategy_id': instance['strategy_id'], 'state': 'VERIFIED_FACTS_ONLY', 'operational_enabled': False}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(json.load(sys.stdin))))
    except Exception:
        print('FACTUAL_BINDING_PROVENANCE_REJECTED', file=sys.stderr)
        sys.exit(1)
