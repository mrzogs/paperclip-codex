import { SESSION_SCHEMA, SESSION_MODE, nativeConfigurationHash } from './operational-native-sessions.mjs';
import { objectHash } from './common.mjs';

// Explicit mock-only facts. These exercise the consumer contract, not a native
// installation, loaded module, broker execution or physical qualification.
export function mockNativeProof(context,rows,{year=2025,month=1,firstDay=1}={}) {
  const settings={chart_timezone:'UTC',start_time1:0,end_time1:86399,start_time2:0,end_time2:0,
    use_second_start_end_times:0,trading_day_starts_previous_date:0};
  const run={run_id:context.run_id,instance_id:'EXPLICIT_MOCK_INSTANCE',instance_role:'replay',chartbook:'C:/EXPLICIT_MOCK_ONLY.cht',
    chart_number:1,run_started_utc:'2026-10-08T12:00:00Z',run_ended_utc:'2026-10-08T13:00:00Z',study_name:'Sierra Trade Telemetry Logger v0.5.44'};
  const attempt={run_id:run.run_id,attempt_id:1,attempt_number:1,start_command_id:'EXPLICIT_MOCK_START',
    attempt_started_utc:run.run_started_utc,attempt_ended_utc:run.run_ended_utc,starting_trade_id:-1,starting_fill_id:-1};
  const observations=[],trades=[],links=[],fills=[];
  for(const [index,row] of rows.entries()) {
    const day=(Date.UTC(year,month-1,firstDay+index)-Date.UTC(1899,11,30))/86400000;
    Object.assign(row,{entry_datetime:day+0.5,trade_account:'Sim1',symbol:'EXPLICIT_MOCK_SYMBOL'});
    const trade={...row,instance_id:run.instance_id,instance_role:'replay',is_simulated:1,trade_symbol:null,status:'closed',exit_datetime:day+0.6};
    const observation={...settings,run_id:run.run_id,attempt_id:1,instance_id:run.instance_id,instance_role:'replay',
      trade_account:trade.trade_account,symbol:trade.symbol,trade_symbol:null,chartbook:run.chartbook,chart_number:1,
      session_observation_mode:SESSION_MODE,trading_day_date:day,trading_day_start_datetime:day,
      session_config_hash:nativeConfigurationHash(settings),first_observed_replay_datetime:day+0.5,last_observed_replay_datetime:day+0.6,
      start_boundary_observed:0,end_boundary_observed:0,rewind_observed:0,fill_cursor_reset_observed:0,coverage_gap_observed:0,
      coverage_status:'mapping_only',provenance_source:'sierra_native_callback',data_quality_flags:'native_session_mapping_only',
      consumer_coverage_status:'mapping_only',native_session_coverage_complete:0,zero_trade_coverage_verified:0,
      statistical_independence_verified:0,brain_eligible:0,session_observation_id:`EXPLICIT_MOCK_${run.run_id}_${index}`};
    observations.push(observation);trades.push(trade);
    for(const role of ['entry','exit']) {
      const at=role==='entry'?trade.entry_datetime:trade.exit_datetime;
      links.push({trade_id:row.trade_id,session_observation_id:observation.session_observation_id,link_role:role,
        source_fill_datetime:at,provenance_source:'sierra_native_callback'});
      fills.push({trade_id:row.trade_id,fill_id:index*2+(role==='exit'?1:0),leg_type:role==='exit'?'final_exit':'entry',run_id:run.run_id,instance_id:run.instance_id,
        trade_account:trade.trade_account,symbol:trade.symbol,is_simulated:1,fill_datetime:at,leg_fill_datetime:at});
    }
  }
  const source={run,attempt,managed_context:{run_id:run.run_id,context_hash:context.context_hash,session_observation_mode:SESSION_MODE},
    receipts:[{run_id:run.run_id,attempt_id:attempt.attempt_id,instance_id:run.instance_id,closed_trade_count:rows.length,
      trade_count:rows.length,data_quality_flags:null}],observations,trades,links,fills};
  return {schema_version:SESSION_SCHEMA,context,...source,producer_verification:{verified:true,proof_basis:'EXPLICIT_MOCK_ONLY'},
    source_receipt_hash:objectHash(source)};
}
