"""Read only published, sealed provider artifacts; never extract a credential."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

MEMBERS = {
 'S23.3':['ocean-provider-binding.json','ocean-test-communication-contract.json'],
 'S24.1':['brain-ocean-binding.json'],
 'S25.1':['telemetry-factual-instance-inventory.json','telemetry-run-binding.json'],
 'S26.2':['gateway-provider-binding.json','gateway-consumer-configuration-contract.json'],
 'S27.2':['strategy-provider-binding.json','strategy-factual-binding-attestation.json'],
 'S28.2':['brain-provider-binding.json','brain-operational-policy-contract.json'],
}

def main():
 request=json.load(sys.stdin)
 spec=importlib.util.spec_from_file_location('setup_verify',Path(__file__).with_name('verify-setup-bundle.py'))
 verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)
 result=verifier.verify(request)
 assert result['receipt'].get('status') in ['PASS','VERIFIED_REUSE']
 with zipfile.ZipFile(request['bundle_path']) as z:
  artifacts=[]
  for name in MEMBERS[request['task_id']]:
   member='artifacts/'+name
   data=z.read(member)
   assert len(data)<=2*1024*1024
   artifacts.append({'logical_output':name,'bundle_path':member,'sha256':hashlib.sha256(data).hexdigest(),'document':json.loads(data)})
 result['artifacts']=artifacts
 print(json.dumps(result))

if __name__=='__main__':
 try: main()
 except Exception: print('{"error":"INTEGRATION_BUNDLE_REJECTED"}',file=sys.stderr);sys.exit(1)
