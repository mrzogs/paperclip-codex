import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


binding = load('binding', 'verify-factual-binding.py')
fixture = load('fixture', 'qualification-fixture.py')


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ocean-s302-')
        self.root = Path(self.tmp.name)
        inputs = json.loads(Path(os.environ['OCEAN_S302_INPUTS']).read_bytes())
        self.request = fixture.make(self.root, inputs)

    def tearDown(self):
        self.tmp.cleanup()

    def alter(self, role, target, changes):
        with zipfile.ZipFile(self.request['bundles'][role]['bundle_path']) as archive:
            receipt, facts, attestation = [json.loads(archive.read(name)) for name in ['receipt.json', 'artifacts/facts.json', 'artifacts/observation-evidence.json']]
        {'receipt': receipt, 'facts': facts, 'attestation': attestation}[target].update(changes)
        self.request['bundles'][role] = fixture.seal(self.root, receipt, facts, attestation)

    def test_valid_exact_fourteen_proofs_and_no_completion(self):
        result = binding.verify(self.request)
        self.assertEqual(result['state'], 'VERIFIED_FACTS_ONLY')
        self.assertFalse(result['operational_enabled'])
        self.assertEqual(len(result['proofs']), 14)
        for ref in self.request['bundles'].values():
            with self.assertRaises(Exception):
                binding.verifier.verify(ref)
            with self.assertRaises(Exception):
                binding.verifier.verify({'task_id': 'S30.2', 'bundle_path': ref['bundle_path'], 'bundle_sha256': ref['bundle_sha256']})

    def test_swapped_role(self):
        self.request['bundles']['source'], self.request['bundles']['strategy'] = self.request['bundles']['strategy'], self.request['bundles']['source']
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_wrong_owner_and_mock_rejected(self):
        self.alter('source', 'receipt', {'owner': 'VWAP Strategy'})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_mock_classification_rejected(self):
        self.alter('source', 'receipt', {'evidence_classification': 'MOCK'})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_synthetic_attestation_rejected(self):
        self.alter('strategy', 'attestation', {'synthetic': True})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_null_and_additional_facts_rejected(self):
        self.alter('source', 'facts', {'instance.chart_id': None, 'unexpected': 'not allowed'})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_different_target_rejected(self):
        self.alter('strategy', 'receipt', {'target_execution_instance_id': 'other-source'})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_tampered_hash_rejected(self):
        self.request['bundles']['source']['bundle_sha256'] = '0' * 64
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_future_task_baseline_rejected(self):
        baseline = {'task_id': 'S30.2', 'bundle_path': 'not-present', 'bundle_sha256': '0' * 64}
        self.alter('source', 'receipt', {'baseline': baseline})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_shared_instance_ids_not_filename_ids(self):
        instance_id = 'installation:chart/one'
        self.request['instance']['execution_instance_id'] = instance_id
        self.alter('source', 'facts', {'instance.execution_instance_id': instance_id})
        for role in ['source', 'strategy']:
            self.alter(role, 'receipt', {'target_execution_instance_id': instance_id})
        self.assertEqual(binding.verify(self.request)['instance']['execution_instance_id'], instance_id)

    def test_no_proof_pointer_substitution(self):
        self.request['proofs']['profile_hash']['pointer'] = '/strategy_code_hash'
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_bad_timestamp_rejected_in_real_verifier(self):
        self.alter('source', 'receipt', {'created_at_utc': 'not-a-time'})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_naive_timestamp_rejected_in_real_verifier(self):
        self.alter('source', 'receipt', {'created_at_utc': '2026-01-01T00:00:00'})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_future_timestamp_rejected_in_real_verifier(self):
        self.alter('source', 'receipt', {'created_at_utc': '2999-01-01T00:00:00Z'})
        with self.assertRaises(Exception): binding.verify(self.request)

    def test_normalized_invalid_offset_rejected(self):
        self.alter('source', 'receipt', {'created_at_utc': '2026-01-01T00:00:00+00:60'})
        with self.assertRaises(Exception): binding.verify(self.request)


if __name__ == '__main__': unittest.main()
