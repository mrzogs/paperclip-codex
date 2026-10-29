import fs from 'node:fs/promises';
import path from 'node:path';

export async function openStallOutput(root,{io=fs,ended=()=>false}={}){
  const check=()=>{if(ended())throw Error('CAPTURE_ENDED');};
  check();root=path.resolve(root);
  if(await io.realpath(root)!==root)throw Error('OUTPUT_ROOT_REJECTED');check();
  const folder=path.join(root,'diagnostics');
  try{await io.mkdir(folder);}catch(error){if(error.code!=='EEXIST')throw error;}check();
  const stat=await io.lstat(folder);check();
  if(!stat.isDirectory()||stat.isSymbolicLink()||await io.realpath(folder)!==folder)throw Error('OUTPUT_ROOT_REJECTED');check();
  // Exclusive fixed filename: an existing artifact, including a symlink, never
  // gets overwritten or rearmed by this process or a replacement PID.
  return io.open(path.join(folder,'sync-stall-capture.jsonl'),'wx');
}
