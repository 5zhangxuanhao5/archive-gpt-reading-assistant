import base64
import hashlib
import json
from pathlib import Path
import shutil
import shlex
import sys

source = Path(__file__).resolve().parent
manifest = json.loads(source.parent.joinpath('manifest.json').read_text('utf-8'))
public = base64.b64decode(manifest['key'])
extension_id = ''.join(chr(ord('a') + int(n, 16)) for n in hashlib.sha256(public).hexdigest()[:32])
if sys.platform != 'darwin':
    raise SystemExit('此安装程序用于 macOS。')
destination = Path.home() / 'Library/Application Support/Yueji'
destination.mkdir(parents=True, exist_ok=True)
destination.chmod(0o700)
if (source / 'yueji_host.py').resolve() != (destination / 'yueji_host.py').resolve():
    shutil.copy2(source / 'yueji_host.py', destination / 'yueji_host.py')
destination.joinpath('yueji_host.py').chmod(0o600)
launcher = destination / 'launch-host'
# Keep the previously installed interpreter; upgrades must not silently replace
# a working launcher with the shell's possibly different Python installation.
if not launcher.exists():
    launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(destination / 'yueji_host.py')) + ' "$@"\n', 'utf-8')
launcher.chmod(0o700)
host = {'name': 'com.yueji.notes', 'description': 'GPT Reading Assistant local Markdown notes', 'path': str(launcher), 'type': 'stdio', 'allowed_origins': ['chrome-extension://' + extension_id + '/']}
for browser in ('Microsoft Edge', 'Google/Chrome'):
    location = Path.home() / 'Library/Application Support' / browser / 'NativeMessagingHosts'
    location.mkdir(parents=True, exist_ok=True)
    registration = location / 'com.yueji.notes.json'
    registration.write_text(json.dumps(host, indent=2), 'utf-8')
    registration.chmod(0o600)
print('本地文件组件已安装到 Edge 和 Chrome；两个浏览器共用同一笔记目录和缓存，已选位置会持续保留。')
