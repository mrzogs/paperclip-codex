import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {strategyCaseSummaries} from './ui-api.mjs';

test('strategy case navigation is bounded, isolated and never reads evidence blobs',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE ow_cases(id TEXT,strategy_id TEXT,instance_id TEXT,run_id TEXT,
      stage TEXT,work_status TEXT,revision INTEGER,owner_id TEXT,payload_json TEXT)`);
    const insert=db.prepare('INSERT INTO ow_cases VALUES(?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<220;i++)insert.run(`case-${i}`,'strategy-a','sim','run','RESEARCH_REVIEW','BLOCKED',i,'owner','not parsed');
    insert.run('other','strategy-b','other','other','CLOSED','COMPLETED',1,'other','not parsed');
    // There are intentionally no artifact/research tables. Deep validation would fail.
    const rows=strategyCaseSummaries(db,'strategy-a','VWAP');
    assert.equal(rows.length,200);assert.equal(rows[0].case_id,'case-219');
    assert.equal(rows.at(-1).case_id,'case-20');
    assert.ok(rows.every(row=>row.strategy_id==='strategy-a'&&row.strategy_name==='VWAP'));
    assert.ok(rows.every(row=>row.validation_state==='NOT_EVALUATED_IN_LIST'));
    assert.ok(rows.every(row=>/Open case details/.test(row.next_action)));
    assert.ok(rows.every(row=>!('approvals' in row)&&!('research' in row)&&!('authorized' in row)));
    assert.deepEqual(strategyCaseSummaries(db,'missing','Missing'),[]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ow_cases').get().n,221);
  } finally {db.close();}
});

test('strategy lists use navigation summaries while case details retain full checks',()=>{
  const source=fs.readFileSync(new URL('./ui-api.mjs',import.meta.url),'utf8');
  assert.match(source,/cases: strategyCaseSummaries\(db,value.id,registry.strategy_name\)/);
  assert.match(source,/const caseRow = \(value\) => \(\{ \.\.\.backend.readCase\(actor, value.id\)/);
  assert.match(source,/\.\.\.caseRow\(row\), strategy: strategyRow/);
});
