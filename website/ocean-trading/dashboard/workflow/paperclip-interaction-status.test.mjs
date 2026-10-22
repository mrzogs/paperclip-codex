import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enrichPaperclipPendingInteractions, readPaperclipPendingInteractions } from './paperclip-interaction-status.mjs';

const company='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspace='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const issueId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const interactionId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-paperclip-interaction-'));
  const configPath=path.join(root,'config.json');
  fs.writeFileSync(configPath,JSON.stringify({schema_version:'ocean-paperclip-interaction-projection/v1',
    paperclip:{company_id:company,project_id:project,workspace_id:workspace,company_prefix:'OCEA'},
    issues:[{issue_id:issueId,issue_identifier:'OCEA-55',purpose:'Capability designations',response_owner:'Wayne / Paperclip board'}],
    safety:{read_only:true,automatic_approval:false,runtime_authority:false}}));
  const responses=new Map([
    ['/api/issues/OCEA-55',{id:issueId,identifier:'OCEA-55',companyId:company,projectId:project,projectWorkspaceId:workspace,title:'Name supervised-host owners',status:'in_review'}],
    [`/api/issues/${issueId}/interactions`,[{id:interactionId,companyId:company,issueId,kind:'ask_user_questions',status:'pending',
      title:'Name accountable owners',summary:'Name or withhold each designation.',createdAt:'2026-10-22T16:24:31Z',
      payload:{secret:'must-not-project',questions:[{id:'collector',prompt:'Name the collector owner.',selectionMode:'single',options:[{id:'x',label:'secret option'}]}]}}]],
  ]);
  const fetchImpl=async value=>{const url=new URL(value),payload=responses.get(url.pathname);return {ok:Boolean(payload),status:payload?200:404,json:async()=>payload||null};};
  return {root,configPath,fetchImpl,responses};
}

test('projects the exact pending Paperclip interaction with owner and direct URL',async()=>{
  const f=fixture();
  try {
    const result=await readPaperclipPendingInteractions({configPath:f.configPath,fetchImpl:f.fetchImpl,apiBase:'http://127.0.0.1:3100/api'});
    assert.equal(result.state,'CURRENT'); assert.equal(result.items.length,1);
    assert.deepEqual(result.items[0].questions,[{id:'collector',prompt:'Name the collector owner.'}]);
    assert.equal(result.items[0].response_owner,'Wayne / Paperclip board');
    assert.equal(result.items[0].url,'http://127.0.0.1:3100/OCEA/issues/OCEA-55');
    assert.equal(JSON.stringify(result).includes('must-not-project'),false);
    assert.equal(JSON.stringify(result).includes('secret option'),false);
    const enriched=await enrichPaperclipPendingInteractions({counts:{action_required:2,pending_gates:3}},
      {configPath:f.configPath,fetchImpl:f.fetchImpl});
    assert.equal(enriched.counts.action_required,3); assert.equal(enriched.counts.pending_gates,4);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('fails closed on a mismatched Paperclip issue binding',async()=>{
  const f=fixture();
  try {
    f.responses.set('/api/issues/OCEA-55',{id:issueId,identifier:'OCEA-55',companyId:company,projectId:'ffffffff-ffff-4fff-8fff-ffffffffffff',projectWorkspaceId:workspace});
    const result=await readPaperclipPendingInteractions({configPath:f.configPath,fetchImpl:f.fetchImpl});
    assert.equal(result.state,'UNAVAILABLE'); assert.equal(result.action_required,false); assert.deepEqual(result.items,[]);
    assert.equal(result.error_code,'PAPERCLIP_INTERACTION_ISSUE_BINDING_MISMATCH');
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
