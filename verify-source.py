#!/usr/bin/env python3
"""Verify a downloaded recovery source tree without installing or running it."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys

root=Path(__file__).resolve().parent
manifest=root/'SOURCE_MANIFEST.json'
if not manifest.is_file():
    raise SystemExit('SOURCE_MANIFEST.json is missing. Use the complete source package.')
data=json.loads(manifest.read_text(encoding='utf-8'))
failed=[]
for item in data['files']:
    relative=PurePosixPath(item['path'])
    if relative.is_absolute() or '..' in relative.parts:
        raise SystemExit('Unsafe manifest path')
    path=root.joinpath(*relative.parts)
    if path.is_symlink() or not path.is_file():
        failed.append((item['path'],'missing or symlink'))
        continue
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):
            digest.update(block)
    if path.stat().st_size!=item['bytes'] or digest.hexdigest()!=item['sha256']:
        failed.append((item['path'],'content mismatch'))
if failed:
    for path,reason in failed:
        print(reason+': '+path,file=sys.stderr)
    raise SystemExit(1)
print('Verified '+str(len(data['files']))+' source/resource files. No installation or application launch performed.')
