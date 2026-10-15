import {get} from './db.js';
import {nativeRequest} from './native-transport.js';
export {nativeRequest} from './native-transport.js';
class NativeDirectory {
  constructor(path, name) { this.path = path; this.name = name; this.kind = 'directory'; }
  async queryPermission() { try { return (await nativeRequest({op: 'STATUS'})).connected ? 'granted' : 'prompt'; } catch { return 'prompt'; } }
  async isSameEntry(other) { return other instanceof NativeDirectory && other.path === this.path; }
  async getDirectoryHandle(name, {create = false} = {}) { const path = [this.path, name].filter(Boolean).join('/'); await nativeRequest({op: 'DIRECTORY', path, create}); return new NativeDirectory(path, name); }
  async getFileHandle(name, {create = false} = {}) { const path = [this.path, name].filter(Boolean).join('/'); await nativeRequest({op: 'FILE', path, create}); return new NativeFile(path, name); }
  async removeEntry(name) { return nativeRequest({op: 'REMOVE', path: [this.path, name].filter(Boolean).join('/')}); }
  async *entries() { const result = await nativeRequest({op: 'ENTRIES', path: this.path}); for (const entry of result.entries) { const path = [this.path, entry.name].filter(Boolean).join('/'); yield [entry.name, entry.kind === 'directory' ? new NativeDirectory(path, entry.name) : new NativeFile(path, entry.name)]; } }
}
class NativeFile {
  constructor(path, name) { this.path = path; this.name = name; this.kind = 'file'; }
  async getFile() {
    const result = await nativeRequest({op: 'FILE', path: this.path});
    const readBlob = async () => {
      const bytes = []; let offset = 0;
      const op = this.path.startsWith('.gpt-reader-assets/') ? 'READ_ASSET' : 'READ';
      do { const result = await nativeRequest({op, path: this.path, offset}); bytes.push(Uint8Array.from(atob(result.data), ch => ch.charCodeAt(0))); offset = result.next; if (offset >= result.size) break; } while (true);
      return new Blob(bytes);
    };
    return {size: result.size, lastModified: result.lastModified, text: async () => (await readBlob()).text(), arrayBuffer: async () => (await readBlob()).arrayBuffer()};
  }
  async createWritable() {
    const expected = await (await this.getFile()).text(); let text = '';
    return {write: async value => { text = value; }, close: () => nativeRequest({op: 'WRITE', path: this.path, text, expected}), abort: async () => {}};
  }
}
export async function rootHandle() {
  if (await get('nativeMode')) {
    return new NativeDirectory('', await get('nativeName') || '笔记库');
  }
  return get('root');
}
