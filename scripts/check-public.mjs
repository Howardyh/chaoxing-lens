import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const dirs=new Set(['src','skill','scripts','test','.github']);
const roots=new Set(['README.md','README.en.md','package.json','package-lock.json','.gitignore','.gitattributes']);
const skip=new Set(['.git','node_modules','dist','local','work','outputs']);
const found=[];
async function scan(dir,prefix=''){for(const item of await readdir(dir,{withFileTypes:true})){const rel=prefix?prefix+'/'+item.name:item.name;if(!prefix&&skip.has(item.name))continue;if(!prefix&&!dirs.has(item.name)&&!roots.has(item.name))throw new Error('Unreviewed public root: '+rel);if(item.isSymbolicLink())throw new Error('Public symlink not allowed: '+rel);if(item.isDirectory()){await scan(path.join(dir,item.name),rel);continue}if(!/\.(?:[cm]?js|json|html|md|ps1|ya?ml)$/.test(rel)&&!['.gitignore','.gitattributes'].includes(rel))throw new Error('Unreviewed public file: '+rel);const text=await readFile(path.join(dir,item.name),'utf8');for(const rule of [/\bgh[opusr]_[a-zA-Z0-9]{20,}/,/-----BE(?:GIN)[^\n]*PRIVATE KEY-----/,/[?&](?:enc|standardEnc|openc)=[a-f\d]{20,}/i,/C:[\\/]+Users[\\/]+float/i])if(rule.test(text))throw new Error('Potential private content in '+rel);found.push(rel)}}
await scan(root);console.log(`Public allowlist checked: ${found.length} source/document/test files; runtime data excluded`);
