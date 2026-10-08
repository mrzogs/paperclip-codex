import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {digest,sealedHash} from './common.mjs';
import {startUiTestHost} from './ui-test-host.mjs';

test('deep isolated evidence clone enrolls through the real short-path schema/auth host and closes only owned temporary state',async()=>{
  const temp=path.resolve(os.tmpdir()),owned=fs.mkdtempSync(path.join(temp,'ocean-ui-evidence-'));
  const evidence=path.join(owned,'long-evidence-'.repeat(7),'long-source-'.repeat(7));
  const clone=path.join(evidence,'private/legacy-clone/dashboard');
  const schema='workflow/contracts/2.1.0/shared-contracts/shared-contracts.schema.json';
  const saved={...process.env};let app;
  try {
    fs.mkdirSync(path.dirname(clone),{recursive:true});
    fs.cpSync(fileURLToPath(new URL('../',import.meta.url)),clone,{recursive:true,errorOnExist:true});
    assert.ok(path.join(clone,schema).length>260);
    const original=fs.readFileSync(path.join(clone,schema));
    process.env.OCEAN_S21_ROOT=evidence;
    app=await startUiTestHost({fixtureOptions:{authorizedTests:['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT','VALIDATION','RESEARCH_EXPERIMENT']}});
    assert.equal(app.evidenceRoot,evidence);assert.ok(path.join(app.dashboard,schema).length<=240);
    assert.deepEqual(fs.readFileSync(path.join(app.dashboard,schema)),original);
    assert.equal(app.config.test_only,true);assert.equal(app.config.namespace,'TEST');
    assert.equal(app.config.brain_submission,'OFF');assert.equal(app.config.live_real,'DISABLED');
    assert.equal(app.config.dispatch_worker,'OFF');assert.equal(app.config.identities.length,3);
    assert.ok(app.config.identities.every(identity=>identity.namespace==='TEST'&&identity.audience==='Ocean workflow TEST'));
    const f=app.fixture,run=f.registered[0].run.context.run_id;
    assert.equal(f.registered.length,2);
    const approval=await f.call(`approvals/${f.primary.approval.request_id}`);
    assert.equal(approval.namespace,'TEST');
    assert.ok(approval.snapshot.authorized_tests.includes('VALIDATION'));
    assert.ok(approval.snapshot.authorized_tests.includes('RESEARCH_EXPERIMENT'));
    await f.call(`run-manager/context/${run}`,{role:null,expected:401});
    await f.call(`run-manager/context/${run}`,{role:'TELEMETRY',headers:{'x-role':'HUMAN'},expected:403});
    await f.call(`run-manager/context/${run}`,{role:'TELEMETRY',headers:{Origin:app.base},expected:403});
    const invalid={...f.registered[0].profile,unsupported_fixture_authority:true};
    invalid.profile_hash=sealedHash(invalid,'profile_hash');
    const denied=await f.call('profiles',{data:{profile:invalid,file_sha256:digest(JSON.stringify(invalid))},expected:422});
    assert.equal(denied.error.code,'SHARED_CONTRACT_REJECTED');
    const privateRoot=app.privateRoot;
    await app.close();assert.equal(app.server.listening,false);app=null;
    assert.equal(fs.existsSync(privateRoot),false);
    assert.deepEqual(fs.readFileSync(path.join(clone,schema)),original);
    const remove=fs.rmSync,warn=console.warn,warnings=[];let blockedRoot;
    try {
      fs.rmSync=function(file,options){
        if(path.basename(String(file)).startsWith('ocean-ui-test-')){
          blockedRoot=String(file);throw Object.assign(Error('MOCK_TEMP_CLEANUP_LOCK'),{code:'EPERM'});
        }
        return remove.call(this,file,options);
      };
      console.warn=message=>warnings.push(message);
      await assert.rejects(startUiTestHost({fixtureOptions:{instanceOverrides:{0:{telemetry_producer_id:'unbound-test-producer'}}}}),
        /TEST_PRODUCER_BINDING_REQUIRED/);
      assert.ok(warnings.some(message=>String(message).includes('OWNED_TEST_ROOT_CLEANUP_FAILED: EPERM')));
    } finally {
      fs.rmSync=remove;console.warn=warn;
      if(blockedRoot){
        assert.ok(blockedRoot.startsWith(temp+path.sep)&&path.basename(blockedRoot).startsWith('ocean-ui-test-'));
        fs.rmSync(blockedRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});
      }
    }
  } finally {
    if(app)await app.close();
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
    Object.assign(process.env,saved);
    assert.ok(owned.startsWith(temp+path.sep)&&path.basename(owned).startsWith('ocean-ui-evidence-'));
    try {fs.rmSync(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
    catch(error) {console.warn(`OWNED_EVIDENCE_FIXTURE_CLEANUP_FAILED: ${error.code || 'UNKNOWN'}`);}
  }
});
