#!/usr/bin/env python3
"""Shared Chrome/Edge notes host, with one local cache and an explicit vault."""
import base64
import fcntl
import json
import os
import re
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import uuid

HOST_DIR = Path(__file__).resolve().parent
CONFIG = HOST_DIR / 'vault.json'
MAX_FILE = 8 * 1024 * 1024
CHUNK = 256 * 1024
MAX_IMAGE = 20 * 1024 * 1024
ASSET_PATH = re.compile(r"^\.gpt-reader-assets/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp|bmp|avif)$", re.I)
MAX_CACHE = 256 * 1024 * 1024
CACHE_KEY = re.compile(r'^(?:state|nativeMode|nativeName|asset:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:outline|reading):https://(?:chatgpt\.com|chat\.openai\.com)(?:/[^\s]*)?)$', re.I)
LOCK_TOKEN = re.compile(r'^[A-Za-z0-9_.:-]{1,128}$')
_database = None
_lock_file = None
_lock_token = None
_snapshots = {}
_uploads = {}

class CacheBusyError(Exception):
    pass

def cache_key(value):
    if not isinstance(value, str) or len(value) > 4096 or not CACHE_KEY.fullmatch(value):
        raise ValueError('无效的共享缓存键')
    return value

def cache_lock_file():
    global _lock_file
    if _lock_file is None:
        HOST_DIR.mkdir(parents=True, exist_ok=True)
        HOST_DIR.chmod(0o700)
        _lock_file = (HOST_DIR / 'cache.lock').open('a+b')
        os.chmod(_lock_file.fileno(), 0o600)
    return _lock_file

def acquire_cache(token):
    global _lock_token
    if not isinstance(token, str) or not LOCK_TOKEN.fullmatch(token):
        raise ValueError('无效的共享缓存锁')
    if _lock_token is not None:
        return _lock_token == token
    try:
        fcntl.flock(cache_lock_file().fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    _lock_token = token
    return True

def release_cache(token):
    global _lock_token
    if token != _lock_token or _lock_token is None:
        raise ValueError('共享缓存锁不属于此连接')
    fcntl.flock(cache_lock_file().fileno(), fcntl.LOCK_UN)
    _lock_token = None

def locked_write(callback):
    temporary_token = None
    if _lock_token is None:
        temporary_token = 'operation:' + uuid.uuid4().hex
        if not acquire_cache(temporary_token):
            raise CacheBusyError('另一浏览器正在保存，请稍后重试')
    try:
        return callback()
    finally:
        if temporary_token:
            release_cache(temporary_token)

def cache_database():
    global _database
    if _database is None:
        def initialize():
            global _database
            database = sqlite3.connect(HOST_DIR / 'cache.sqlite3', timeout=0.1)
            try:
                database.execute('PRAGMA journal_mode=WAL')
                database.execute('PRAGMA synchronous=FULL')
                database.execute('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value BLOB NOT NULL, revision INTEGER NOT NULL)')
                database.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL)')
                database.execute("INSERT OR IGNORE INTO metadata VALUES ('revision', 0)")
                database.commit()
                for suffix in ('', '-wal', '-shm'):
                    path = HOST_DIR / ('cache.sqlite3' + suffix)
                    if path.exists():
                        path.chmod(0o600)
                _database = database
            except Exception:
                database.close()
                raise
        locked_write(initialize)
    return _database

def cache_revisions():
    if not (HOST_DIR / 'cache.sqlite3').exists():
        return (0, 0)
    try:
        query = "SELECT value, COALESCE((SELECT revision FROM cache WHERE key='state'), 0) FROM metadata WHERE key='revision'"
        if _database is not None:
            row = _database.execute(query).fetchone()
            return (row[0], row[1]) if row else (0, 0)
        with sqlite3.connect('file:' + str(HOST_DIR / 'cache.sqlite3') + '?mode=ro', uri=True, timeout=0.1) as database:
            row = database.execute(query).fetchone()
            return (row[0], row[1]) if row else (0, 0)
    except sqlite3.Error:
        return (0, 0)

def cache_revision():
    return cache_revisions()[0]

def cache_status():
    revision, state_revision = cache_revisions()
    return {'cacheProtocol': 1, 'cacheRevision': revision, 'stateRevision': state_revision}

def cache_payload(data, maximum=MAX_CACHE):
    if not isinstance(data, str) or len(data) > ((maximum + 2) // 3) * 4:
        raise ValueError('共享缓存数据过大')
    try:
        content = base64.b64decode(data, validate=True)
    except Exception:
        raise ValueError('共享缓存数据无效')
    if len(content) > maximum:
        raise ValueError('共享缓存数据过大')
    return content

def put_cache(key, content):
    cache_key(key)
    if len(content) > MAX_CACHE:
        raise ValueError('共享缓存数据超过 256 MB')
    try:
        json.loads(content)
    except (ValueError, UnicodeError):
        raise ValueError('共享缓存数据不是有效 JSON')
    def save():
        database = cache_database()
        with database:
            database.execute("UPDATE metadata SET value=value+1 WHERE key='revision'")
            revision = database.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0]
            database.execute('INSERT INTO cache VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=excluded.revision', (key, sqlite3.Binary(content), revision))
        return {'revision': revision}
    return locked_write(save)

def cache_operation(message):
    operation = message['op']
    if operation == 'CACHE_LOCK':
        return {'acquired': acquire_cache(message.get('token'))}
    if operation == 'CACHE_UNLOCK':
        release_cache(message.get('token'))
        return {}
    if operation == 'CACHE_PUT':
        return put_cache(message.get('key'), cache_payload(message.get('data')))
    if operation == 'CACHE_GET':
        key = cache_key(message.get('key'))
        offset = message.get('offset', 0)
        if not isinstance(offset, int) or offset < 0:
            raise ValueError('无效的共享缓存读取位置')
        snapshot = message.get('snapshot')
        if snapshot:
            saved = _snapshots.get(snapshot)
            if not saved or saved['key'] != key:
                raise ValueError('共享缓存读取已结束，请重新读取')
        else:
            if offset != 0:
                raise ValueError('共享缓存首段必须从零读取')
            row = cache_database().execute('SELECT value,revision FROM cache WHERE key=?', (key,)).fetchone()
            if row is None:
                return {'found': False, 'revision': cache_revision()}
            if len(_snapshots) >= 16:
                raise ValueError('共享缓存读取过多，请先释放已有读取')
            stream = tempfile.TemporaryFile(dir=HOST_DIR, prefix='.cache-read-')
            stream.write(row[0])
            snapshot = uuid.uuid4().hex
            saved = {'key': key, 'stream': stream, 'size': len(row[0]), 'revision': row[1]}
            _snapshots[snapshot] = saved
        if offset > saved['size']:
            raise ValueError('共享缓存读取位置超出范围')
        saved['stream'].seek(offset)
        content = saved['stream'].read(CHUNK)
        return {'found': True, 'snapshot': snapshot, 'size': saved['size'], 'next': offset + len(content), 'data': base64.b64encode(content).decode('ascii'), 'revision': saved['revision']}
    if operation == 'CACHE_READ_RELEASE':
        saved = _snapshots.pop(message.get('snapshot'), None)
        if saved:
            saved['stream'].close()
        return {}
    if operation == 'CACHE_WRITE_BEGIN':
        key = cache_key(message.get('key'))
        size = message.get('size')
        if not isinstance(size, int) or size < 1 or size > MAX_CACHE:
            raise ValueError('共享缓存数据超过 256 MB，或大小无效')
        if len(_uploads) >= 4:
            raise ValueError('共享缓存写入过多，请先完成已有写入')
        upload = uuid.uuid4().hex
        _uploads[upload] = {'key': key, 'size': size, 'next': 0, 'stream': tempfile.TemporaryFile(dir=HOST_DIR, prefix='.cache-write-')}
        return {'upload': upload}
    if operation == 'CACHE_WRITE_ABORT':
        saved = _uploads.pop(message.get('upload'), None)
        if saved:
            saved['stream'].close()
        return {}
    if operation in ('CACHE_WRITE_CHUNK', 'CACHE_WRITE_COMMIT'):
        upload = message.get('upload')
        saved = _uploads.get(upload)
        if saved is None:
            raise ValueError('共享缓存写入已结束，请重新写入')
        if operation == 'CACHE_WRITE_CHUNK':
            offset = message.get('offset')
            if offset != saved['next']:
                raise ValueError('共享缓存写入顺序错误')
            content = cache_payload(message.get('data'), CHUNK)
            if not content or saved['next'] + len(content) > saved['size']:
                raise ValueError('共享缓存写入大小错误')
            saved['stream'].write(content)
            saved['next'] += len(content)
            return {'next': saved['next']}
        if saved['next'] != saved['size']:
            raise ValueError('共享缓存尚未写入完整')
        saved['stream'].seek(0)
        result = put_cache(saved['key'], saved['stream'].read())
        _uploads.pop(upload)
        saved['stream'].close()
        return result
    raise ValueError('不支持的共享缓存操作')

def config():
    return json.loads(CONFIG.read_text('utf-8')) if CONFIG.exists() else {}

def save_config(data):
    CONFIG.write_text(json.dumps(data, ensure_ascii=False), 'utf-8')
    CONFIG.chmod(0o600)

def root_path():
    value = config().get('root')
    if not value:
        raise ValueError('尚未选择笔记文件夹')
    root = Path(value).resolve()
    if not root.is_dir():
        raise ValueError('笔记文件夹已移动或不可用，请重新设置位置')
    return root

def inside(relative):
    if not isinstance(relative, str) or '\\' in relative or Path(relative).is_absolute() or any(p in ('.', '..') for p in relative.split('/')):
        raise ValueError('无效的文件路径')
    root = root_path()
    candidate = root.joinpath(relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError('不能访问笔记库以外的文件')
    return candidate

def image_path(relative):
    if not isinstance(relative, str) or not ASSET_PATH.fullmatch(relative):
        raise ValueError('无效的图片文件路径')
    return inside(relative)

def image_bytes(content, extension):
    valid = {
        'png': len(content) >= 24 and content.startswith(b'\x89PNG\r\n\x1a\n'),
        'jpg': len(content) >= 4 and content.startswith(b'\xff\xd8\xff'),
        'gif': len(content) >= 13 and content[:6] in (b'GIF87a', b'GIF89a'),
        'webp': len(content) >= 16 and content[:4] == b'RIFF' and content[8:12] == b'WEBP',
        'bmp': len(content) >= 26 and content.startswith(b'BM'),
        'avif': len(content) >= 16 and content[4:8] == b'ftyp' and (b'avif' in content[:32] or b'avis' in content[:32]),
    }.get(extension.lower(), False)
    if not valid or len(content) > MAX_IMAGE:
        raise ValueError('图片格式无效，或图片超过 20 MB')

def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.yueji-', delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        except Exception:
            temporary.unlink(missing_ok=True); raise
    try:
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True); raise

def handle(message):
    operation = message.get('op')
    if isinstance(operation, str) and operation.startswith('CACHE_'):
        return cache_operation(message)
    if operation == 'STATUS':
        data = config()
        return {'connected': bool(data.get('root')), 'name': Path(data.get('root', '')).name, 'path': data.get('root', ''), **cache_status()}
    if operation == 'CHOOSE':
        if sys.platform == 'darwin':
            result = subprocess.run(['/usr/bin/osascript', '-e', 'POSIX path of (choose folder with prompt "选择要使用的笔记文件夹（可在此窗口自行新建）")'], capture_output=True, text=True)
            if result.returncode:
                raise ValueError('已取消选择文件夹')
            parent = Path(result.stdout.strip())
        else:
            import tkinter as tk
            from tkinter import filedialog
            window = tk.Tk(); window.withdraw()
            selected = filedialog.askdirectory(title='选择要使用的笔记文件夹（可在此窗口自行新建）')
            window.destroy()
            if not selected:
                raise ValueError('已取消选择文件夹')
            parent = Path(selected)
        root = parent.resolve()
        if not root.is_dir():
            raise ValueError('请选择已有文件夹')
        save_config({'root': str(root)})
        return {'name': root.name, 'path': str(root), 'connected': True, **cache_status()}
    if operation == 'ENTRIES':
        path = inside(message.get('path', ''))
        result = []
        for item in path.iterdir():
            if item.is_symlink() or item.name.startswith('.'):
                continue
            result.append({'name': item.name, 'kind': 'directory' if item.is_dir() else 'file'})
        return {'entries': result}
    if operation == 'DIRECTORY':
        path = inside(message['path'])
        if message.get('create'):
            path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir():
            raise FileNotFoundError('文件夹不存在')
        return {}
    if operation == 'FILE':
        path = inside(message['path'])
        if path.exists() and not path.is_file():
            raise ValueError('该名称已被文件夹使用')
        if not path.exists():
            if not message.get('create'):
                raise FileNotFoundError('文件不存在')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        return {'size': path.stat().st_size, 'lastModified': path.stat().st_mtime_ns // 1000000}
    if operation == 'READ_ASSET':
        path = image_path(message['path'])
        if path.stat().st_size > MAX_IMAGE:
            raise ValueError('图片超过 20 MB')
        offset = max(0, int(message.get('offset', 0)))
        with path.open('rb') as stream:
            stream.seek(offset); content = stream.read(CHUNK)
        return {'data': base64.b64encode(content).decode('ascii'), 'size': path.stat().st_size, 'offset': offset, 'next': offset + len(content)}
    if operation == 'WRITE_ASSET':
        path = image_path(message['path'])
        data = message.get('data')
        if not isinstance(data, str) or len(data) > ((MAX_IMAGE + 2) // 3) * 4:
            raise ValueError('图片超过 20 MB')
        try:
            content = base64.b64decode(data, validate=True)
        except Exception:
            raise ValueError('图片数据无效')
        image_bytes(content, path.suffix[1:])
        if path.exists():
            if not path.is_file() or path.stat().st_size != len(content) or path.read_bytes() != content:
                raise ValueError('图片文件已被其他软件修改，已保留浏览器备份')
            return {}
        atomic_write(path, content)
        return {}
    if operation == 'READ':
        path = inside(message['path'])
        if path.stat().st_size > MAX_FILE:
            raise ValueError('文件超过 8 MB')
        offset = max(0, int(message.get('offset', 0)))
        with path.open('rb') as stream:
            stream.seek(offset); content = stream.read(CHUNK)
        return {'data': base64.b64encode(content).decode('ascii'), 'size': path.stat().st_size, 'offset': offset, 'next': offset + len(content)}
    if operation == 'WRITE':
        path = inside(message['path'])
        content = str(message.get('text', '')).encode('utf-8')
        if len(content) > MAX_FILE:
            raise ValueError('文件超过 8 MB')
        expected = message.get('expected')
        if expected is not None:
            current = path.read_text('utf-8') if path.exists() else ''
            if current != expected:
                raise ValueError('文件在保存前被其他软件修改，已保留本地备份')
        atomic_write(path, content)
        return {}
    if operation == 'REMOVE':
        path = inside(message['path'])
        if not path.is_file():
            raise ValueError('只能清理旧笔记文件')
        path.unlink()
        return {}
    raise ValueError('不支持的操作')

def main():
    while True:
        length = sys.stdin.buffer.read(4)
        if not length:
            return
        size = struct.unpack('=I', length)[0]
        if size > 32 * 1024 * 1024:
            return
        body = sys.stdin.buffer.read(size)
        if len(body) != size:
            return
        try:
            message = json.loads(body)
            result = {'ok': True, **handle(message)}
        except Exception as error:
            result = {'ok': False, 'error': str(error), 'name': 'NotFoundError' if isinstance(error, FileNotFoundError) else type(error).__name__}
        output = json.dumps(result, ensure_ascii=False).encode('utf-8')
        if len(output) > 1024 * 1024:
            output = b'{"ok":false,"error":"Too many directory entries"}'
        sys.stdout.buffer.write(struct.pack('=I', len(output)) + output)
        sys.stdout.buffer.flush()

if __name__ == '__main__':
    main()
