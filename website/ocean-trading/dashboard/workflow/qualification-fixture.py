"""Isolated software fixtures only. Never evidence of a physical Sierra source."""
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('qualification', ROOT / 'verify-factual-qualification.py')
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


def seal(directory, receipt, facts, attestation, observations=b'ISOLATED SOFTWARE FIXTURE - NOT A PHYSICAL OBSERVATION'):
    encode = lambda value: json.dumps(value, indent=2).encode()
    members = {'receipt.json': encode(receipt), 'report.md': b'Isolated software test fixture; never enroll in production.',
               'artifacts/facts.json': encode(facts), 'artifacts/observation-evidence.json': encode(attestation),
               'artifacts/observations/fixture.txt': observations}
    filemap = {'qualification_id': receipt['qualification_id'], 'files': [
        {'bundle_path': key, 'sha256': hashlib.sha256(value).hexdigest()} for key, value in members.items()]}
    members['file-map.json'] = encode(filemap)
    members['checksums.sha256'] = ''.join(hashlib.sha256(value).hexdigest() + '  ' + key + '\n' for key, value in members.items()).encode()
    filename = directory / (receipt['qualification_id'] + '.zip')
    with zipfile.ZipFile(filename, 'w', zipfile.ZIP_DEFLATED) as archive:
        for key, value in members.items():
            archive.writestr(key, value)
    return {'schema_version': 'ocean-factual-qualification-reference/v1', 'qualification_id': receipt['qualification_id'],
            'qualification_role': receipt['qualification_role'], 'bundle_path': str(filename),
            'bundle_sha256': hashlib.sha256(filename.read_bytes()).hexdigest()}


def make(directory, inputs):
    now = datetime.now(timezone.utc).isoformat()
    instance = {'execution_instance_id': 'isolated-physical-shape-one', 'strategy_id': 'isolated_strategy',
                'source_installation_id': 'isolated-source', 'chartbook_id': 'isolated-book', 'chart_id': 'isolated-chart',
                'source_study_instance_id': 'isolated-study', 'telemetry_producer_id': 'isolated-operational-caller',
                'version_binding': 'fixture-version', 'config_hash': 'sha256:' + 'a' * 64, 'account_alias': 'ISOLATED_ONLY',
                'capabilities': ['REPLAY'], 'status': 'DRAFT', 'lease_run_id': None}
    request = {'instance': instance, 'strategy_code_hash': 'sha256:' + 'b' * 64, 'profile_hash': 'sha256:' + 'c' * 64,
               'source_observed_at_utc': now, 'bundles': {}, 'proofs': {}}
    for role in ['source', 'strategy']:
        baseline = next(row for row in inputs if row['task_id'] == qualification.BASELINES[role][0])
        receipt = {'schema_version': 'ocean-factual-qualification/v1', 'qualification_id': 'isolated-' + role,
                   'qualification_role': role, 'parent_task_id': 'S30.2', 'owner': qualification.OWNERS[role][0],
                   'status': 'PASS', 'scope': 'FACTS_ONLY_NOT_TASK_COMPLETION', 'evidence_classification': qualification.CLASSIFICATION[role],
                   'target_execution_instance_id': instance['execution_instance_id'], 'created_at_utc': now,
                   'baseline': {'task_id': baseline['task_id'], 'bundle_path': baseline['path'], 'bundle_sha256': baseline['sha256']},
                   'facts_member': 'artifacts/facts.json', 'attestation_member': 'artifacts/observation-evidence.json'}
        facts = {key: instance[key.split('.')[1]] if key.startswith('instance.') else request[key] for key in qualification.FIELDS[role]}
        attestation = {'schema_version': 'ocean-factual-observation-evidence/v1', 'qualification_id': receipt['qualification_id'],
                       'observer': 'ISOLATED SOFTWARE TEST', 'observed_at_utc': now, 'method': 'Fixture exercises parser, never a source observation',
                       'synthetic': False, 'source_artifacts': [{'member': 'artifacts/observations/fixture.txt',
                         'sha256': hashlib.sha256(b'ISOLATED SOFTWARE FIXTURE - NOT A PHYSICAL OBSERVATION').hexdigest()}]}
        request['bundles'][role] = seal(directory, receipt, facts, attestation)
        request['proofs'].update({key: {'member': 'artifacts/facts.json', 'pointer': '/' + key} for key in facts})
    return request


if __name__ == '__main__':
    args = json.load(sys.stdin)
    directory = Path(args['directory'])
    assert directory.name.startswith('ocean-s302-') and directory.is_dir()
    print(json.dumps(make(directory, json.loads(Path(args['inputs']).read_bytes()))))
