import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const target=process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.env.CODEX_HOME || path.join(homedir(),'.codex'),'skills/chaoxing-study');
const source=path.join(root,'dist/chaoxing-study');
async function files(dir,prefix='') { let entries; try {entries=await readdir(dir,{withFileTypes:true})} catch(e) {if(e.code==='ENOENT')return [];throw e}; const result=[]; for(const item of entries){if(item.isSymbolicLink())throw new Error('Symlink requires manual review');const rel=path.join(prefix,item.name);if(item.isDirectory())result.push(...await files(path.join(dir,item.name),rel));else result.push(rel)}return result; }
const incoming=await files(source); if(!incoming.length)throw new Error('Run npm run build first');
const backup=path.join(root,'local/backups',new Date().toISOString().replace(/[:.]/g,'-'));
const previous=await files(target), manifest=[];
for(const rel of previous){const bytes=await readFile(path.join(target,rel)),dest=path.join(backup,rel);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,bytes,{flag:'wx'});const hash=createHash('sha256').update(bytes).digest('hex');if(createHash('sha256').update(await readFile(dest)).digest('hex')!==hash)throw new Error('Backup mismatch');manifest.push({path:rel,sha256:hash,bytes:bytes.length})}
if(previous.length){await writeFile(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2));console.log(`Verified backup: ${backup}`)}
for(const rel of incoming){const destination=path.join(target,rel);await mkdir(path.dirname(destination),{recursive:true});await copyFile(path.join(source,rel),destination);if(!Buffer.from(await readFile(path.join(source,rel))).equals(await readFile(destination)))throw new Error('Install mismatch')}
console.log(`Installed and verified ${incoming.length} files: ${target}`);
