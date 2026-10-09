import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from './store.mjs';
import { WorkflowBackend } from './backend.mjs';
import { OceanAuth, issueOceanIdentity, issueLocalBrowserSecret } from './auth.mjs';
import { digest } from './common.mjs';
import { researchReportContent } from './operational-research-report.mjs';

// Explicit mock report/job/evidence rows in a disposable DB. Production auth,
// artifact writer, report resolver and HTTP handler execute unchanged. No Brain,
// telemetry, native replay, live credential or operational database is opened.
export async function exportFixture({large=true,version='ocean-cumulative-research/v6',compactInline=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-report-export-')),environment={};
  const store=new WorkflowStore(path.join(root,'workflow.sqlite')),backend=Object.create(WorkflowBackend.prototype);
  const publicRoot=path.resolve(fileURLToPath(new URL('../public/',import.meta.url)));
  const baseline=digest('EXPLICIT_MOCK_BASELINE'),binding=digest('EXPLICIT_MOCK_BINDING');
  const definitions=[['brain','BRAIN','s','i',['read','artifact.write','event.write']],
    ['strategy','STRATEGY','s','i',['read']],['intruder','TELEMETRY','s','i',['read']],
    ['wrong-instance','BRAIN','s','other-instance',['read']],['wrong-strategy','BRAIN','other','i',['read']],
    ['no-read','BRAIN','s','i',['artifact.write']]];
  const config={test_only:true,pending_services:[],identities:[],operational_factual_bindings:[],allowed_origins:[],
    browser:{subject_id:'wayne-ocean-ui',credential_ref:'OCEAN_MOCK_BROWSER_SECRET'}};
  for(const [name,role,strategy,instance,scopes] of definitions) {
    config.identities.push(issueOceanIdentity({identity_id:name,role,namespace:'OPERATIONAL',
      strategy_ids:[strategy],instance_ids:[instance],scopes,factual_binding_hash:binding,
      credential_ref:`OCEAN_MOCK_${name.replaceAll('-','_').toUpperCase()}_TOKEN`,audience:'Ocean workflow operational v1'},
    environment,new Date(Date.now()+3600000).toISOString()));
    config.operational_factual_bindings.push({binding_hash:binding,strategy_id:strategy,instance:{execution_instance_id:instance}});
  }
  issueLocalBrowserSecret(environment,config.browser.credential_ref);
  Object.assign(backend,{db:store.db,store,config,environment,validate:()=>{},
    authFailureWindowMs:300000,authFailureThreshold:3,authFailureTotals:{401:0,403:0},authFailureBuckets:new Map()});
  backend.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('p','s','1',baseline,'{}');
  backend.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run('s','p',1,baseline,'{}');
  backend.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run('i','s','{}');
  backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run('r','s','i','COMPLETED','{}');
  backend.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,'brain',NULL,'{\"registry_revision\":1}')")
    .run('mock-case','s','i','r',baseline);
  const actor={id:'brain',role:'BRAIN',namespace:'OPERATIONAL',strategyIds:['s'],instanceIds:['i'],scopes:['read','artifact.write','event.write']};
  const sourceId='test-mock-recommendation',artifactId='test-mock-outcome',jobId='research-mock';
  backend.writeArtifact(actor,{artifact_id:sourceId,case_id:'mock-case',run_id:'r',recipient_id:'strategy',kind:'RECOMMENDATION',
    media_type:'application/json',content:'{}',content_hash:digest('{}'),candidate_hash:null,dependency_ids:[]});
  const result={schema_version:version,outcome:'NO_SUPPORTED_CHANGE',authority:{automatic_strategy_change:false,
    candidate_approved:false,paper_authorized:false,live_authorized:false},candidate_validation:{status:'NOT_DUE',candidate_hash:null},
    aggregate:{trades:60,gross_profit_loss:0,fees:60,net_profit_loss:-60,wins:0,losses:60,flat:0},
    contradictions:[{reason:'EXPLICIT_MOCK_RETAINED_CONTRADICTION',detail:'retained evidence '.repeat(large?10000:2)}]};
  const input_json=JSON.stringify({result}),job={id:jobId,case_id:'mock-case',artifact_id:sourceId,artifact_hash:digest('{}'),
    analysis_version:version,input_json,input_hash:digest(input_json),completed_at_utc:'2026-10-08T18:00:00.000Z'};
  const report={...result,job_id:job.id,case_id:job.case_id,source_recommendation_id:job.artifact_id,
    source_recommendation_hash:job.artifact_hash,completed_at_utc:job.completed_at_utc};
  const content=compactInline?JSON.stringify(report)+'\n':researchReportContent(job,report);
  backend.writeArtifact(actor,{artifact_id:artifactId,case_id:job.case_id,run_id:'r',recipient_id:'strategy',kind:'OUTCOME',
    media_type:'application/json',content,content_hash:digest(content),candidate_hash:null,dependency_ids:[sourceId]});
  backend.db.prepare(`INSERT INTO ow_research_jobs(id,case_id,artifact_id,artifact_hash,analysis_version,state,next_attempt_ms,
    input_json,input_hash,result_artifact_id,result_hash,created_at_utc,completed_at_utc) VALUES(?,?,?,?,?,'COMPLETED',0,?,?,?,?,?,?)`)
    .run(job.id,job.case_id,job.artifact_id,job.artifact_hash,version,input_json,job.input_hash,artifactId,digest(content),job.completed_at_utc,job.completed_at_utc);
  backend.db.prepare("UPDATE ow_cases SET work_status='COMPLETED' WHERE id='mock-case'").run();
  let base;
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,base);
      // UI counts are a labelled fixture. Report/auth requests use the real handler.
      if(url.pathname==='/api/workflow/view/dashboard') {
        backend.auth.authenticate(req,false);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({counts:{action_required:0}}));return;
      }
      if(await backend.handle(req,res,url))return;
      const relative=url.pathname.startsWith('/improvement/')?'workflow/index.html':url.pathname.slice(1);
      const file=path.resolve(publicRoot,relative);
      if(!file.startsWith(publicRoot+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.statusCode=404;res.end();return;}
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
      res.setHeader('Content-Type',types[path.extname(file)] || 'application/octet-stream');res.end(fs.readFileSync(file));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{code:error.code || 'EXPLICIT_MOCK_HOST_ERROR'}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  config.allowed_origins=[base];backend.auth=new OceanAuth(config,store,environment);
  const login=await fetch(base+'/api/workflow/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({credential:''})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(route,{identity,headers={},method='GET'}={})=>fetch(base+'/api/workflow/'+route,{method,headers:{
    ...(identity?{Authorization:`Bearer ${environment[config.identities.find(item=>item.identity_id===identity).credential_ref]}`}:{Cookie:cookie}),...headers}});
  return {backend,base,report,content,artifactId,sourceId,jobId,request,cookie,
    snapshot:()=>Object.fromEntries(['ow_artifacts','ow_research_jobs','ow_cases','ow_events','ow_approval_requests','ow_decisions']
      .map(table=>[table,backend.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    async close(){await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
