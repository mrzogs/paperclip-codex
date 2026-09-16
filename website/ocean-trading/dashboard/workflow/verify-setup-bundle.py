"""Validate a local operator-selected receipt archive; never extract or mutate it."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

def stream_hash(stream):
    hasher=hashlib.sha256()
    for block in iter(lambda:stream.read(1024*1024),b''):hasher.update(block)
    return hasher.hexdigest()

def verify(request):
    assert set(request)=={'bundle_path','bundle_sha256','task_id'}
    filename=Path(request['bundle_path'])
    assert filename.is_absolute() and filename.stat().st_size<=512*1024*1024
    taskmap=json.loads((Path(__file__).parent/'setup-task-map.json').read_text())
    bindings=taskmap['tasks']
    binding=next(row for row in bindings if row['task_id']==request['task_id'])
    assert filename.name==binding['bundle']
    sha=lambda value:hashlib.sha256(value).hexdigest()
    with filename.open('rb') as stream:assert stream_hash(stream)==request['bundle_sha256']
    with zipfile.ZipFile(filename) as z:
        assert sum(row.file_size for row in z.infolist())<=2*1024*1024*1024 and len(z.infolist())<=10000
        assert all(row.file_size<=512*1024*1024 for row in z.infolist())
        names=z.namelist()
        assert len(names)==len(set(n.casefold() for n in names)) and z.testzip() is None
        assert all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts and ':' not in n and '\\' not in n for n in names)
        sums={}
        for line in z.read('checksums.sha256').decode('utf-8-sig').splitlines():
            if not line.strip():continue
            digest,name=line.split(maxsplit=1);name=name.strip().lstrip('*')
            assert name not in sums
            with z.open(name) as stream:assert stream_hash(stream)==digest
            sums[name]=digest
        assert set(sums)=={n for n in names if not n.endswith('/') and n!='checksums.sha256'}
        receipt=json.loads(z.read('receipt.json'))
        assert receipt['task_id']==binding['task_id']
        # Sealed Brain/Ocean receipts use project; sealed Telemetry receipts use owner.
        owners=[receipt[key] for key in ['project','owner'] if key in receipt]
        aliases=taskmap.get('owner_aliases',{}).get(binding['owner'],[binding['owner']])
        assert owners and all(owner in aliases for owner in owners)
        statuses=['PASS','VERIFIED_REUSE','BLOCKED','FAILED','NOT_RUN','WAITING_FOR_EVENT']
        if binding['task_id'] in ['S46.2','S47.2']:statuses.append('NO_NEW_COVERAGE')
        status_field=taskmap.get('historical_status_fields',{}).get(binding['task_id'],'status')
        status=receipt.get('status',receipt.get(status_field))
        assert status in statuses
        if 'status' in receipt and status_field in receipt: assert receipt['status']==receipt[status_field]
        if binding['task_id'] in taskmap.get('diagnostic_only',[]): assert status=='BLOCKED'
        filemap=json.loads(z.read('file-map.json'))
        assert filemap['task_id']==binding['task_id']
        mapped=set()
        for row in filemap.get('files',filemap.get('outputs',[])):
            name=row['bundle_path']
            assert name in sums and name not in mapped
            assert sums[name]==row['sha256'].removeprefix('sha256:')
            mapped.add(name)
        assert {n for n in sums if n.startswith('artifacts/')}<=mapped
    return {'receipt':receipt,'bundle_sha256':request['bundle_sha256'],'owner':binding['owner'],'verified_members':{name:sums[name] for name in sorted(mapped)}}

def main():
    print(json.dumps(verify(json.load(sys.stdin))))

if __name__=='__main__':
    try:main()
    except Exception:print('{"error":"SETUP_BUNDLE_REJECTED"}',file=sys.stderr);sys.exit(1)
