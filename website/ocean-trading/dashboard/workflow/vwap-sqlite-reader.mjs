import { DatabaseSync } from 'node:sqlite';

const [databasePath,strategyId]=process.argv.slice(2);
if(!databasePath||!strategyId)throw new Error('VWAP_SQLITE_READER_ARGUMENTS_REQUIRED');
const db=new DatabaseSync(databasePath,{readOnly:true,timeout:1000});
try {
  db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
  const object=db.prepare("SELECT name FROM sqlite_master WHERE name IN ('ocean_trade_causal_v1','trades') AND type IN ('table','view') ORDER BY CASE name WHEN 'ocean_trade_causal_v1' THEN 0 ELSE 1 END LIMIT 1").get()?.name;
  if(!object)throw new Error('VWAP_SOURCE_TABLE_MISSING');
  const available=new Set(db.prepare(`PRAGMA table_info("${object}")`).all().map(row=>row.name));
  for(const required of ['trade_id','strategy_id','status'])if(!available.has(required))throw new Error('VWAP_SOURCE_COLUMN_MISSING:'+required);
  const causalColumns=['trade_id','environment','trade_account','is_simulated','run_id','strategy_id','strategy_version',
    'status','entry_datetime','exit_datetime','context_status','setup_id','session_name','side','direction','regime_label',
    'volatility_label','vwap_reclaim_state','quality_flags','updated_utc','dataset_role','context_hash','strategy_code_hash',
    'strategy_config_hash','dataset_id'];
  const projection=causalColumns.filter(column=>available.has(column)).map(column=>`"${column}"`);
  for(const [preferred,fallback] of [['net_profit_loss','profit_loss'],['mfe_points','max_favourable_excursion'],['mae_points','max_adverse_excursion']]){
    if(available.has(preferred))projection.push(`"${preferred}"`);
    else if(available.has(fallback))projection.push(`"${fallback}" AS "${preferred}"`);
  }
  const rows=db.prepare(`SELECT ${projection.join(',')} FROM "${object}" WHERE strategy_id=? AND status='closed' COLLATE NOCASE ORDER BY trade_id`).all(strategyId);
  process.stdout.write(JSON.stringify(rows));
} finally { db.close(); }
