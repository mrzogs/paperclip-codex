"""Validate a local operator-selected receipt archive; never extract or mutate it."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

def main():
    request=json.load(sys.stdin)
    assert set(request)=={'bundle_path','bundle_sha256','task_id'}
    filename=Path(request['bundle_path'])
    assert filename.is_absolute() and filename.stat().st_size<=64*1024*1024
    bindings=json.loads((Path(__file__).parent/'setup-task-map.json').read_text())['tasks']
    binding=next(row for row in bindings if row['task_id']==request['task_id'])
    assert filename.name==binding['bundle']
    sha=lambda value:hashlib.sha256(value).hexdigest()
    assert sha(filename.read_bytes())==request['bundle_sha256']
    with zipfile.ZipFile(filename) as z:
        assert sum(row.file_size for row in z.infolist())<=128*1024*1024
        names=z.namelist()
        assert len(names)==len(set(names)) and z.testzip() is None
        assert all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts and ':' not in n and '\\' not in n for n in names)
        sums={}
        for line in z.read('checksums.sha256').decode('utf-8-sig').splitlines():
            if not line.strip():continue
            digest,name=line.split(maxsplit=1);name=name.strip().lstrip('*')
            assert name not in sums and sha(z.read(name))==digest
            sums[name]=digest
        assert set(sums)=={n for n in names if not n.endswith('/') and n!='checksums.sha256'}
        receipt=json.loads(z.read('receipt.json'))
        assert receipt['task_id']==binding['task_id'] and receipt['project']==binding['owner']
        assert receipt['status'] in ['PASS','VERIFIED_REUSE','BLOCKED','FAILED','NOT_RUN']
        filemap=json.loads(z.read('file-map.json'))
        for row in filemap['files']:
            if row.get('bundle_path'):assert sha(z.read(row['bundle_path']))==row['sha256'].removeprefix('sha256:')
    print(json.dumps({'receipt':receipt,'bundle_sha256':request['bundle_sha256'],'owner':binding['owner']}))

if __name__=='__main__':
    try:main()
    except Exception:print('{"error":"SETUP_BUNDLE_REJECTED"}',file=sys.stderr);sys.exit(1)
