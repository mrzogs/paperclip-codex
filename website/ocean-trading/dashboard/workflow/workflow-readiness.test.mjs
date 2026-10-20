import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { prepareOperation, commitOperation } from './operator.mjs';
import { WorkflowBackend } from './backend.mjs';

test('loopback readiness binds the deployed release and persistent learning workers', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-workflow-readiness-'));
  const operation=prepareOperation({action:'bootstrap',root,operator_id:'S-1-5-21-1000'});
  commitOperation(operation);
  const environment={...operation.next.environment,OCEAN_DEPLOYMENT_RELEASE_ID:'test-release',
    OCEAN_DEPLOYMENT_SOURCE_COMMIT:'a'.repeat(40),OCEAN_DEPLOYMENT_MANIFEST_SHA256:'b'.repeat(64)};
  const server=http.createServer((request,response)=>backend.handle(request,response,new URL(request.url,`http://${request.headers.host}`)));
  let backend;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    backend=new WorkflowBackend({...operation.next.config,allowed_origins:[origin]},environment);
    backend.operationalLearning.enabled=true;backend.operationalLearning.identityVerified=true;backend.operationalLearning.lastError=null;
    backend.operationalLearning.status=()=>{throw new Error('readiness must not enumerate learning evidence');};
    const response=await fetch(`${origin}/api/workflow/readiness`,{headers:{Origin:origin}});
    assert.equal(response.status,200);
    const readiness=await response.json();
    assert.deepEqual(readiness.workflow.deployment,{release_id:'test-release',source_commit:'a'.repeat(40),manifest_sha256:'b'.repeat(64)});
    assert.equal(readiness.workflow.state,'READY');assert.equal(readiness.workflow.schema_version,13);
    assert.deepEqual(readiness.workflow.operational_learning,{enabled:true,state:'READY',last_error:null});
    assert.equal(readiness.workflow.candidate_evaluator.version,'ocean-operational-candidate-evaluator/v2');
    assert.ok(['READY','RUNNING'].includes(readiness.workflow.candidate_evaluator.state));
    assert.equal(readiness.workflow.candidate_evaluator.last_error,null);
  }finally{
    backend?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});
