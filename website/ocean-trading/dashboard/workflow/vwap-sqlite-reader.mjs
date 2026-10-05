import { DatabaseSync } from 'node:sqlite';

const [databasePath,strategyId]=process.argv.slice(2);
if(!databasePath||!strategyId)throw new Error('VWAP_SQLITE_READER_ARGUMENTS_REQUIRED');
const db=new DatabaseSync(databasePath,{readOnly:true,timeout:1000});
try {
  db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
  const object=db.prepare("SELECT name FROM sqlite_master WHERE name IN ('ocean_trade_causal_v1','trades') AND type IN ('table','view') ORDER BY CASE name WHEN 'ocean_trade_causal_v1' THEN 0 ELSE 1 END LIMIT 1").get()?.name;
  if(!object)throw new Error('VWAP_SOURCE_TABLE_MISSING');
  const rows=db.prepare('SELECT * FROM '+object+" WHERE strategy_id=? AND lower(status)='closed' ORDER BY trade_id").all(strategyId);
  process.stdout.write(JSON.stringify(rows));
} finally { db.close(); }
