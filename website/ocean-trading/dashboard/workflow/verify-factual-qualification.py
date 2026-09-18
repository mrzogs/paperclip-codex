"""Protected-operator-selected facts receipts, never full setup/task completion."""
import hashlib
import importlib.util
import json
import re
import stat
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import zipfile
from jsonschema import Draft202012Validator
from provider_schema_formats import format_checker

ROOT = Path(__file__).parent
SCHEMA = json.loads((ROOT / 'contracts/factual-qualification-v1.schema.json').read_bytes())
BASELINES = {
    'source': ('S25.1', 'bc46d3b3824873d86dd4d89abbd91e3b98acb769971de14e156ccc811f9cf657'),
    'strategy': ('S27.2', 'fed8efa5914deeab4a35308828f078d8ab18001749e16570090aba2b3571235c'),
}
OWNERS = {'source': ('Telemetry Data Logger', 'Telemetry Logger'), 'strategy': ('VWAP Strategy',)}
CLASSIFICATION = {'source': 'ACTUAL_SOURCE_OBSERVATION', 'strategy': 'ACTUAL_LOADED_STRATEGY_ATTESTATION'}
FIELDS = {
    'source': {'instance.' + key for key in ('execution_instance_id', 'source_installation_id', 'chartbook_id', 'chart_id', 'source_study_instance_id', 'telemetry_producer_id', 'account_alias', 'capabilities')} | {'source_observed_at_utc'},
    'strategy': {'instance.strategy_id', 'instance.version_binding', 'instance.config_hash', 'strategy_code_hash', 'profile_hash'},
}


def validate(value, definition):
    Draft202012Validator({**SCHEMA, '$ref': '#/$defs/' + definition}, format_checker=format_checker).validate(value)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            assert key not in result
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def observed(value):
    timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    assert timestamp.tzinfo is not None and timestamp <= datetime.now(timezone.utc)
    return timestamp


def verify(reference, role):
    validate(reference, 'qualificationReference')
    assert reference['qualification_role'] == role
    filename = Path(reference['bundle_path'])
    assert filename.is_absolute() and filename.name == reference['qualification_id'] + '.zip'
    assert filename.stat().st_size <= 64 * 1024 * 1024
    with filename.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == reference['bundle_sha256']
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        assert len(entries) <= 1024 and sum(entry.file_size for entry in entries) <= 128 * 1024 * 1024
        assert len(names) == len(set(name.casefold() for name in names))
        assert all(not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts and ':' not in name and '\\' not in name for name in names)
        assert all(entry.file_size <= 16 * 1024 * 1024 and not stat.S_ISLNK(entry.external_attr >> 16) for entry in entries)
        assert archive.testzip() is None
        sums = {}
        for line in archive.read('checksums.sha256').decode('utf-8-sig').splitlines():
            if not line.strip():
                continue
            match = re.fullmatch(r'([a-f0-9]{64})\s+\*?(.+)', line)
            assert match
            digest, name = match.groups()
            assert name not in sums
            assert hashlib.sha256(archive.read(name)).hexdigest() == digest
            sums[name] = digest
        assert set(sums) == {name for name in names if not name.endswith('/') and name != 'checksums.sha256'}
        assert {'receipt.json', 'report.md', 'file-map.json'} <= set(sums)
        receipt = strict_json(archive.read('receipt.json'))
        validate(receipt, 'receipt')
        assert receipt['qualification_id'] == reference['qualification_id']
        assert receipt['qualification_role'] == role and receipt['owner'] in OWNERS[role]
        assert receipt['evidence_classification'] == CLASSIFICATION[role]
        created = observed(receipt['created_at_utc'])
        baseline = receipt['baseline']
        assert (baseline['task_id'], baseline['bundle_sha256']) == BASELINES[role]
        spec = importlib.util.spec_from_file_location('qualification_baseline', ROOT / 'verify-setup-bundle.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        verified = module.verify(baseline)
        assert verified['receipt']['status'] in ('PASS', 'VERIFIED_REUSE')
        assert verified['owner'] in OWNERS[role]
        filemap = strict_json(archive.read('file-map.json'))
        assert filemap['qualification_id'] == reference['qualification_id'] and 'task_id' not in filemap
        mapped = set()
        for row in filemap['files']:
            name = row['bundle_path']
            assert name not in mapped and name in sums and row['sha256'] == sums[name]
            mapped.add(name)
        assert {name for name in sums if name.startswith('artifacts/')} <= mapped
        facts = strict_json(archive.read(receipt['facts_member']))
        assert set(facts) == FIELDS[role]
        assert all(value is not None and value != '' and value != [] for value in facts.values())
        attestation = strict_json(archive.read(receipt['attestation_member']))
        validate(attestation, 'attestation')
        assert attestation['qualification_id'] == reference['qualification_id']
        assert observed(attestation['observed_at_utc']) <= created
        if role == 'source':
            assert facts['source_observed_at_utc'] == attestation['observed_at_utc']
            assert facts['instance.execution_instance_id'] == receipt['target_execution_instance_id']
        for source in attestation['source_artifacts']:
            assert source['member'] in mapped and sums[source['member']] == source['sha256']
            assert len(archive.read(source['member'])) > 0
        return {'receipt': receipt, 'owner': receipt['owner'], 'verified_members': {name: sums[name] for name in mapped}, 'facts': facts}
