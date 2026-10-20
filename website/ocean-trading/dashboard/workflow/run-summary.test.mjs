import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {RunManager} from './run-manager.mjs';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ow_run_progress(id INTEGER PRIMARY KEY,run_id TEXT,payload_json TEXT);
    CREATE TABLE ow_evidence_revisions(run_id TEXT,canonical_id TEXT,market_id TEXT,payload_json TEXT);
    CREATE TABLE ow_coverage_receipts(id INTEGER PRIMARY KEY,run_id TEXT,payload_json TEXT);
    CREATE TABLE ow_trade_pins(id TEXT,run_id TEXT,state TEXT);`);
  return {db,manager:new RunManager({db})};
}

test('large run summary preserves duplicates, conflicts, missing closed pins and open pins',()=>{
  const {db,manager}=fixture();
  try {
    db.exec('BEGIN');
    const evidence=db.prepare('INSERT INTO ow_evidence_revisions VALUES(?,?,?,?)');
    const pin=db.prepare('INSERT INTO ow_trade_pins VALUES(?,?,?)');
    for(let i=0;i<2000;i++){
      pin.run('trade-'+i,'run','CLOSED');
      evidence.run('run','canonical-'+i,'market-'+i,JSON.stringify({trade_id:'trade-'+i,conflicting_fields:i===1?['pnl']:[]}));
    }
    evidence.run('run','canonical-0','market-0',JSON.stringify({trade_id:'trade-0',conflicting_fields:[]}));
    evidence.run('run',null,'market-unattributed',JSON.stringify({trade_id:'unattributed',conflicting_fields:[]}));
    pin.run('missing','run','CLOSED');pin.run('open','run','OPEN');
    db.prepare('INSERT INTO ow_coverage_receipts(run_id,payload_json) VALUES(?,?)').run('run',JSON.stringify({processing_event_count:2002,completed_at_utc:'2026-10-20T16:00:00Z'}));
    db.exec('COMMIT');
    const summary=manager.summary({id:'run'});
    assert.equal(summary.open_pins,1);assert.equal(summary.processing_count,2002);
    assert.equal(summary.unique_canonical_count,2000);assert.equal(summary.unique_market_count,2001);
    assert.equal(summary.unresolved_records,3);assert.equal(summary.completion_current,false);
  } finally {db.close();}
});

test('a drained clean run still reports current completion until newer progress arrives',()=>{
  const {db,manager}=fixture();
  try {
    db.prepare('INSERT INTO ow_evidence_revisions VALUES(?,?,?,?)').run('run','canonical','market',JSON.stringify({trade_id:'trade',conflicting_fields:[]}));
    db.prepare('INSERT INTO ow_trade_pins VALUES(?,?,?)').run('trade','run','CLOSED');
    db.prepare('INSERT INTO ow_coverage_receipts(run_id,payload_json) VALUES(?,?)').run('run',JSON.stringify({processing_event_count:1,completed_at_utc:'2026-10-20T16:00:00Z'}));
    assert.equal(manager.summary({id:'run'}).completion_current,true);
    db.prepare('INSERT INTO ow_run_progress(run_id,payload_json) VALUES(?,?)').run('run',JSON.stringify({observed_at_utc:'2026-10-20T16:00:01Z'}));
    assert.equal(manager.summary({id:'run'}).completion_current,false);
  } finally {db.close();}
});
