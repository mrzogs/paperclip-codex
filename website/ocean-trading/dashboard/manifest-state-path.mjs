import fs from 'node:fs';
import path from 'node:path';

// The mutable data directory and its publishing monitor belong together. A
// controlled release may retain that directory through a junction while only
// Website restarts. Follow the same publisher for the file fallback; never mix
// its fresh SQLite snapshot with a copied, frozen JSON file in the new release.
export function manifestStatePath(dashboard,{exists=fs.existsSync,realpath=fs.realpathSync}={}){
  const data=path.join(dashboard,'data');
  try {if(exists(data))return path.join(path.dirname(realpath(data)),'dashboard-data.json');}
  catch {/* Existing file fallback/error semantics remain unchanged. */}
  return path.join(dashboard,'dashboard-data.json');
}
