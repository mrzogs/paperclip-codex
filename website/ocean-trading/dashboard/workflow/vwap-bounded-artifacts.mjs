import fs from 'node:fs';
import path from 'node:path';
import { digest, requireThat } from './common.mjs';

const MAX_BYTES = 32*1024*1024;
const MAX_TOTAL_BYTES = 128*1024*1024;

/** Read retained local regular files through a fixed descriptor and one bounded
 * budget. Hashes establish integrity; callers separately authenticate custody. */
export function createVwapBoundedArtifactReader({root,maxArtifactBytes=MAX_BYTES,maxTotalArtifactBytes=64*1024*1024,codePrefix='TARGETED_REPLAY_ARTIFACT_'}={}) {
  const check=(condition,code)=>requireThat(condition,409,codePrefix+code);
  check(Number.isSafeInteger(maxArtifactBytes)&&maxArtifactBytes>0&&maxArtifactBytes<=MAX_BYTES
    && Number.isSafeInteger(maxTotalArtifactBytes)&&maxTotalArtifactBytes>0&&maxTotalArtifactBytes<=MAX_TOTAL_BYTES,'BOUNDS_INVALID');
  const components=file=>{
    for(let current=file;;current=path.dirname(current)){
      check(!fs.lstatSync(current).isSymbolicLink(),'ALIAS_PATH_REJECTED');
      if(path.dirname(current)===current)break;
    }
  };
  let allowedRoot=null;
  if(root!==undefined){
    check(typeof root==='string'&&path.isAbsolute(root)&&!root.startsWith('\\\\'),'ROOT_REQUIRED');
    allowedRoot=path.resolve(root);components(allowedRoot);
    check(fs.statSync(allowedRoot).isDirectory()&&fs.realpathSync.native(allowedRoot)===allowedRoot,'ROOT_CONFLICT');
  }
  let consumed=0;
  const read=ref=>{
    check(ref&&typeof ref.path==='string'&&path.isAbsolute(ref.path)&&!ref.path.startsWith('\\\\'),'PATH_REQUIRED');
    const file=path.resolve(ref.path);
    check(!file.slice(path.parse(file).root.length).includes(':'),'ALTERNATE_STREAM_REJECTED');
    if(allowedRoot){const relative=path.relative(allowedRoot,file);
      check(relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'ROOT_CONFLICT');}
    let fd;
    try{
      components(file);
      check(fs.realpathSync.native(file)===file,'ALIAS_PATH_REJECTED');
      const namedBefore=fs.lstatSync(file);
      check(namedBefore.isFile(),'NOT_REGULAR');
      // Reject a FIFO/device/directory before opening it. O_NOFOLLOW adds a
      // platform-supported final-component guard; ancestor identities are also
      // rechecked after the exact-size read.
      fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const before=fs.fstatSync(fd);
      check(before.isFile(),'NOT_REGULAR');
      check(before.ino===namedBefore.ino&&before.dev===namedBefore.dev,'CHANGED_DURING_READ');
      check(before.size<=maxArtifactBytes,'BYTE_LIMIT');
      check(ref.byte_length===undefined||Number.isSafeInteger(ref.byte_length)&&ref.byte_length>=0&&before.size===ref.byte_length,'SIZE_CONFLICT');
      check(consumed+before.size<=maxTotalArtifactBytes,'AGGREGATE_BYTE_LIMIT');
      consumed+=before.size;
      const bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)break;offset+=count;}
      const after=fs.fstatSync(fd),namedAfter=fs.lstatSync(file);
      check(offset===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs
        &&before.ino===after.ino&&before.dev===after.dev&&namedAfter.isFile()&&namedAfter.ino===before.ino
        &&namedAfter.dev===before.dev&&namedAfter.size===before.size&&namedAfter.mtimeMs===before.mtimeMs
        &&namedAfter.ctimeMs===before.ctimeMs,'CHANGED_DURING_READ');
      components(file);check(fs.realpathSync.native(file)===file,'ALIAS_PATH_REJECTED');
      check(ref.sha256===undefined||digest(bytes)===ref.sha256,'HASH_CONFLICT');
      return {path:file,bytes};
    }catch(error){
      if(typeof error?.code==='string'&&error.code.startsWith(codePrefix))throw error;
      check(false,'UNAVAILABLE');
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  };
  return Object.freeze({read,maxArtifactBytes,get consumedBytes(){return consumed;}});
}
