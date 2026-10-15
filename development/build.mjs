import {build} from 'esbuild';
import {cp} from 'node:fs/promises';
await build({entryPoints:['editor-entry.js'],bundle:true,format:'esm',minify:true,outfile:'../vendor/editor.js',legalComments:'eof'});
await cp('node_modules/katex/dist/katex.min.css','../vendor/katex.min.css');
await cp('node_modules/katex/dist/fonts','../vendor/fonts',{recursive:true});
