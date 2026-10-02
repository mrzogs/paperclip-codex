export function normalizeHistoricalCoverage({partitionStartUtc,partitionEndUtc,scoredStartLocal,scoredEndLocal,warmupStartLocal=''}) {
  const minimum=partitionStartUtc.slice(0,16),maximum=partitionEndUtc.slice(0,16);
  let warmup=warmupStartLocal;
  if(warmup && warmup<minimum)warmup=minimum<scoredStartLocal?minimum:'';
  if(warmup && warmup>=scoredStartLocal)warmup='';
  const start=Date.parse(`${scoredStartLocal}Z`),end=Date.parse(`${scoredEndLocal}Z`);
  const partitionStart=Date.parse(partitionStartUtc),partitionEnd=Date.parse(partitionEndUtc);
  let error='';
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)error='The scored end must be after the scored start.';
  else if(start<partitionStart||end>partitionEnd)error=`Choose scored dates between ${partitionStartUtc.replace('.000Z','Z')} and ${partitionEndUtc.replace('.000Z','Z')}.`;
  return {minimum,maximum,warmup,error};
}

export function removeCoveredDatasetDuplicates(items) {
  return items.filter((candidate,index,all)=>!all.slice(0,index).some(other=>
    other.partition===candidate.partition
    && other.symbol===candidate.symbol
    && other.start<=candidate.start
    && other.end>=candidate.end
  ));
}

async function openOperationalRunWizard({modal,postOperational,esc,human,renderIcons,onPrepared,errorText,row}) {
  const host=document.querySelector('#modal-body'),review=row.review,context=review.context;
  const decisionId=`run-release-${crypto.randomUUID()}`;
  modal.dataset.request='';modal.classList.add('run-wizard');
  host.innerHTML=`<form id="run-form"><div class="page-heading"><h2 id="modal-title">Prepare qualified replay run</h2><button type="button" class="icon" data-action="close-modal" title="Close" aria-label="Close"><i data-lucide="x"></i></button></div><p class="subline">TEST replay / Ingestion off / Sierra remains stopped</p><dl class="facts">${[
    ['Strategy',context.strategy_id],['Version',context.strategy_version],['Instance',context.execution_instance_id],['Purpose',human(context.evidence_purpose)],['Dataset',`${context.dataset_manifest_id} / revision ${context.dataset_manifest_revision}`],['Manifest hash',review.manifest_hash],['Code hash',context.strategy_code_hash],['Configuration hash',context.strategy_config_hash],['Workflow profile',review.profile_hash],['Observed profile',review.observed_profile_hash],['Interval',`${review.interval.start_utc} to ${review.interval.end_utc}`],['History action',human(context.historical_build_mode)],['RUN_RELEASE',row.run_release_decision?'Recorded':'Required'],['Reservation',row.run_state || 'Available']
  ].map(([key,value])=>`<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><label class="check-line"><input id="run-confirm" type="checkbox" required>I confirm this exact TEST replay Run Context and RUN_RELEASE. Sierra must not be started by Ocean.</label><p class="form-error" role="alert"></p><div class="footer"><button type="button" data-action="close-modal">Cancel</button><button type="submit" class="primary" id="run-next">Reserve READY</button></div></form>`;
  const form=host.querySelector('form');let busy=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!form.querySelector('#run-confirm').checked)return;
    busy=true;form.querySelector('#run-next').disabled=true;form.querySelector('.form-error').textContent='';
    try{
      if(!row.run_release_decision)await postOperational('decisions',{review,review_hash:review.review_hash,decision_id:decisionId,scope:'RUN_RELEASE',decision:'APPROVED',reason:'Authenticated S41.3 TEST replay smoke-run confirmation in the Ocean Run Wizard.'});
      const result=await postOperational('runs/prepare',{review,review_hash:review.review_hash});
      modal.close();await onPrepared(result);
    }catch(error){form.querySelector('.form-error').textContent=errorText(error);}
    finally{busy=false;form.querySelector('#run-next').disabled=false;}
  });
  renderIcons();modal.showModal();modal.addEventListener('close',()=>modal.classList.remove('run-wizard'),{once:true});
}

function openRunModeChooser({modal,esc,renderIcons,onPaper,onTest}) {
  const host=document.querySelector('#modal-body');modal.dataset.request='';modal.classList.add('run-wizard');
  host.innerHTML=`<div class="page-heading"><h2 id="modal-title">Start New Run</h2><button type="button" class="icon" data-action="close-modal" title="Close" aria-label="Close"><i data-lucide="x"></i></button></div><p class="subline">Choose the governed source environment for this run.</p><div class="mode-choice"><button type="button" class="primary" id="paper-forward-mode">Paper Forward</button><button type="button" id="test-replay-mode">Test / Replay</button></div><p class="muted">Live Real remains disabled.</p>`;
  host.querySelector('#paper-forward-mode').addEventListener('click',onPaper);
  host.querySelector('#test-replay-mode').addEventListener('click',onTest);
  renderIcons();modal.showModal();
}

async function openPaperForwardRunWizard({modal,postOperational,esc,human,renderIcons,onPrepared,errorText,options}) {
  const host=document.querySelector('#modal-body'),runId=`paper-forward-${crypto.randomUUID()}`;let review=null,busy=false,step=0;
  const local=value=>new Date(value).toISOString().slice(0,16);
  const start=new Date(Math.ceil(Date.now()/60000)*60000).toISOString();
  modal.dataset.request='';modal.classList.add('run-wizard');
  host.innerHTML=`<form id="run-form"><div class="page-heading"><h2 id="modal-title">Start Paper Forward run</h2><button type="button" class="icon" data-action="close-modal" title="Close" aria-label="Close"><i data-lucide="x"></i></button></div><p class="subline">Operational paper / Run remains READY / Source handshake pending</p><ol class="wizard-steps"><li>Scope</li><li>Interval</li><li>Review</li></ol><fieldset data-step="0"><div class="wizard-grid"><div class="field"><label for="paper-environment">Environment</label><select id="paper-environment"><option>Paper Forward</option></select></div><div class="field"><label for="paper-instance">Registered paper baseline instance</label><select id="paper-instance"><option value="${esc(options.instance.execution_instance_id)}">${esc(options.instance.account_alias)} / ${esc(options.instance.chartbook_id)} / ${esc(options.instance.chart_id)}</option></select></div><div class="field"><label for="paper-purpose">Purpose</label><select id="paper-purpose"><option>Forward Learning</option></select></div><div class="field"><label for="paper-dataset">Dataset role</label><select id="paper-dataset"><option>Forward Data</option></select></div></div><p class="subline">Baseline ${esc(options.version.version)}. Learning is scoped; no candidate promotion or real-money execution is authorised.</p></fieldset><fieldset data-step="1" hidden><div class="wizard-grid"><div class="field"><label for="paper-start">Forward start (UTC)</label><input id="paper-start" type="datetime-local" required value="${local(start)}"></div><div class="field"><label for="paper-end">Forward end (UTC)</label><input id="paper-end" type="datetime-local" required value="${local(options.maximum_end_utc)}"></div></div><p class="subline">The prospective interval is incomplete by definition. Telemetry must provide the actual paper-source handshake in S50.3 before activation.</p></fieldset><fieldset data-step="2" hidden><div id="paper-review"></div><label class="check-line"><input id="paper-confirm" type="checkbox">I confirm this exact paper instance, fixed baseline, Forward Learning scope and future interval. Keep LIVE_REAL disabled.</label></fieldset><p class="form-error" role="alert"></p><div class="footer"><button type="button" id="paper-back">Back</button><button type="submit" class="primary" id="paper-next">Next</button></div></form>`;
  const form=host.querySelector('form'),field=id=>form.querySelector(`#paper-${id}`);
  const selection=()=>({run_id:runId,strategy_id:options.strategy.strategy_id,version_id:options.version.version_id,instance_id:options.instance.execution_instance_id,expected_environment:'PAPER_FORWARD',purpose:'LEARNING',dataset_role:'FORWARD',start_utc:new Date(`${field('start').value}Z`).toISOString(),end_utc:new Date(`${field('end').value}Z`).toISOString()});
  const show=()=>{form.querySelectorAll('fieldset').forEach((element,index)=>element.hidden=index!==step);form.querySelectorAll('.wizard-steps li').forEach((element,index)=>element.toggleAttribute('aria-current',index===step));field('back').hidden=step===0;field('next').textContent=step===2?'Reserve READY':'Next';field('next').disabled=busy||(step===2&&(!review||!field('confirm').checked));};
  field('back').addEventListener('click',()=>{step--;show();});field('confirm').addEventListener('change',show);
  for(const name of ['start','end'])field(name).addEventListener('change',()=>{review=null;field('confirm').checked=false;});
  form.noValidate=true;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    for(const element of form.querySelectorAll(`fieldset[data-step="${step}"] input,fieldset[data-step="${step}"] select`))if(!element.disabled&&!element.reportValidity())return;
    busy=true;show();form.querySelector('.form-error').textContent='';
    try{
      if(step===0)step=1;
      else if(step===1){
        review=await postOperational('paper-forward/preview',{selection:selection()});
        const r=review.review,c=r.context;
        field('review').innerHTML=`<dl class="facts">${[['Strategy',options.strategy.strategy_name],['Version',c.strategy_version],['Instance',c.execution_instance_id],['Purpose','Forward Learning'],['Dataset','Forward Data'],['Interval',`${r.interval.start_utc} to ${r.interval.end_utc}`],['Code hash',c.strategy_code_hash],['Configuration hash',c.strategy_config_hash],['Workflow profile',r.profile_hash],['Observed profile',r.observed_profile_hash],['Manifest quality','Partial - future interval incomplete'],['Historical reconciliation',r.paper_forward.historical_reconciliation.callback_status],['Source handshake','Pending'],['Result','READY']].map(([key,value])=>`<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
        step=2;
      }else{
        if(!field('confirm').checked||!review)return;
        const result=await postOperational('paper-forward/prepare',{selection:review.selection,review_hash:review.review.review_hash,confirmed:true,reason:'Authenticated S49.3 Paper Forward confirmation for the exact registered paper instance and fixed baseline.'});
        modal.close();await onPrepared(result);
      }
    }catch(error){form.querySelector('.form-error').textContent=errorText(error);if(error.code==='PAPER_FORWARD_REVIEW_CHANGED'){review=null;step=1;}}
    finally{busy=false;show();}
  });
  show();renderIcons();
}

export async function openRunWizard({modal,request,post,postOperational,esc,human,renderIcons,onPrepared,errorText,strategyId,operationalRequestId=null,skipModeChooser=false}) {
  if(!skipModeChooser || operationalRequestId){
    const operational=(await request('operational/v1/release-requests')).items.filter(row=>row.state==='RELEASED' && !row.run_state && (!strategyId || row.review.context.strategy_id===strategyId));
    const selected=operationalRequestId?operational.find(row=>row.request_id===operationalRequestId):operational[0];
    if(selected)return openOperationalRunWizard({modal,postOperational,esc,human,renderIcons,onPrepared,errorText,row:selected});
  }
  if(!skipModeChooser){
    let paper=null;try{paper=await request('operational/v1/paper-forward/options');}catch(error){if(!['CURRENT_PAPER_CONSUMER_BINDING_REQUIRED','UNAMBIGUOUS_PAPER_BINDING_REQUIRED','INSTANCE_ALREADY_RESERVED'].includes(error.code))throw error;}
    if(paper?.eligible)return openRunModeChooser({modal,esc,renderIcons,onPaper:()=>openPaperForwardRunWizard({modal,postOperational,esc,human,renderIcons,onPrepared,errorText,options:paper}),onTest:()=>openRunWizard({modal,request,post,postOperational,esc,human,renderIcons,onPrepared,errorText,strategyId,operationalRequestId,skipModeChooser:true})});
  }
  const options=await request('run-manager/options');
  const host=document.querySelector('#modal-body');let step=0;let review=null;let busy=false;let selectedDatasetKey=null;
  const option=(value,label)=>`<option value="${value===''?'':esc(value)}">${esc(label)}</option>`;
  const select=(name,label)=>`<div class="field"><label for="run-${name}">${label}</label><select id="run-${name}" name="${name}" required></select></div>`;
  const input=(name,label,type='datetime-local',required=true)=>`<div class="field"><label for="run-${name}">${label}</label><input id="run-${name}" name="${name}" type="${type}" ${required?'required':''}></div>`;
  modal.dataset.request='';modal.classList.add('run-wizard');
  host.innerHTML=`<form id="run-form"><div class="page-heading"><h2 id="modal-title">Prepare a run</h2><button type="button" class="icon" data-action="close-modal" title="Close" aria-label="Close"><i data-lucide="x"></i></button></div><p class="subline">TEST / Ingestion off / Sierra is started manually</p><ol class="wizard-steps"><li>Scope</li><li>Coverage</li><li>Review</li></ol><fieldset data-step="0"><div class="field"><label for="run-preset">Saved preset</label><select id="run-preset"><option value="">New run</option>${options.presets.map(p=>option(p.id,p.name)).join('')}</select></div><div class="wizard-grid">${select('strategy','Strategy')}${select('version','Registered version')}${select('environment','Expected environment')}${select('instance','Execution instance')}${select('purpose','Purpose')}${select('dataset','Available verified history')}</div><p id="run-role" class="subline"></p><p class="subline">Live real, Backtest and Import: not enabled.</p></fieldset><fieldset data-step="1" hidden><div class="wizard-grid">${input('start','Scored start (UTC)')}${input('end','Scored end (UTC)')}${input('warmup','Warmup start (UTC, optional)','datetime-local',false)}${select('mode','History action')}${select('case','Case')}${input('experiment','Experiment reference','text',false)}</div><p class="subline">Warmup is optional. Ocean automatically keeps it inside the selected history.</p><p id="run-time-basis" class="subline"></p></fieldset><fieldset data-step="2" hidden><div id="run-review"></div><label class="check-line"><input id="run-confirm" type="checkbox">I confirm this TEST scope and policy.</label><div class="field"><label for="run-save-name">Preset name (optional)</label><input id="run-save-name" maxlength="100"></div></fieldset><p class="form-error" role="alert"></p><div class="footer"><button type="button" id="run-back">Back</button><button type="submit" class="primary" id="run-next">Next</button></div></form>`;
  const form=host.querySelector('form');const field=name=>form.querySelector(`#run-${name}`);const value=name=>field(name).value;
  const fill=(name,rows,previous=value(name))=>{field(name).innerHTML=rows.map(([v,l])=>option(v,l)).join('');if(rows.some(([v])=>v===previous))field(name).value=previous;};
  const environmentRows=[['REPLAY','Replay'],['PAPER_FORWARD','Paper forward']];
  function cascade() {
    const runnable=options.strategies.filter(strategy=>strategy.run_readiness?.ready!==false);
    fill('strategy',runnable.map(strategy=>[strategy.strategy_id,strategy.strategy_name]));
    const unavailable=options.strategies.filter(strategy=>strategy.run_readiness?.ready===false);
    const unavailableMessage=unavailable.length?` Setup incomplete: ${unavailable.map(strategy=>`${strategy.strategy_name} (${strategy.run_readiness.missing.map(human).join(', ')})`).join('; ')}.`:'';
    const versions=options.versions.filter(v=>v.strategy_id===value('strategy')&&!v.blocked);
    fill('version',versions.map(v=>[v.version_id,`${human(v.kind)} / ${v.version}`]));
    const version=versions.find(v=>v.version_id===value('version'));
    fill('environment',environmentRows);
    const compatibleInstances=options.instances.filter(i=>i.strategy_id===value('strategy')&&i.version_binding===version?.version&&i.capabilities.includes(value('environment')));
    const operationalInstances=compatibleInstances.filter(i=>!i.execution_instance_id.startsWith('test-'));
    const instances=operationalInstances.length?operationalInstances:compatibleInstances;
    fill('instance',instances.map(i=>[i.execution_instance_id,`${i.account_alias} / ${i.chartbook_id} / ${i.chart_id}`]));
    const rules=options.purposes.filter(p=>p[0]===value('environment'));
    fill('purpose', [...rules.filter(p=>version?.kind==='CANDIDATE'?['DEVELOPMENT_BACKTEST','RESEARCH_EXPERIMENT','VALIDATION','PROTECTED_HOLDOUT','SHADOW_FORWARD'].includes(p[1]):['LEARNING','HISTORICAL_BUILD'].includes(p[1])).map(p=>[p[1],p[4]]),...(version?.kind==='BASELINE'?[['NOT_ELIGIBLE','No Brain learning']]:[])]);
    const rule=rules.find(p=>p[1]===value('purpose'));
    const eligibleDatasets=options.permissions.filter(p=>p.strategy_id===value('strategy')&&!p.expired&&p.purposes.includes(value('purpose'))).flatMap(p=>p.manifest.partitions.flatMap((part,index)=>!rule||part.partition===rule[2]?[{value:`${p.permission_id}:${index}`,label:`${part.start_utc.slice(0,10)} to ${part.end_utc.slice(0,10)} / ${human(part.partition)} / ${part.symbol}`,partition:part.partition,symbol:part.symbol,start:Date.parse(part.start_utc),end:Date.parse(part.end_utc)}]:[])).sort((a,b)=>(b.end-b.start)-(a.end-a.start)||b.end-a.end);
    const datasets=removeCoveredDatasetDuplicates(eligibleDatasets).map(item=>[item.value,item.label]);
    fill('dataset',datasets);
    const datasetKey=value('dataset');
    if(datasetKey!==selectedDatasetKey) {
      const split=datasetKey.lastIndexOf(':');
      const permission=options.permissions.find(item=>item.permission_id===datasetKey.slice(0,split));
      const partition=permission?.manifest.partitions[Number(datasetKey.slice(split+1))];
      field('start').value=partition?.start_utc?.slice(0,16)||'';
      field('end').value=partition?.end_utc?.slice(0,16)||'';
      field('warmup').value='';
      selectedDatasetKey=datasetKey;
    }
    field('role').textContent=`History source: ${rule?`${human(rule[2])} / ${human(rule[3])}`:'Declared dataset role / No learner use'}. The dates come from verified Sierra bars; they are not a human approval.${unavailableMessage}`;
    fill('mode',value('purpose')==='HISTORICAL_BUILD'?options.build_modes.map(m=>[m,human(m)]):[['','Not applicable']]);field('mode').disabled=value('purpose')!=='HISTORICAL_BUILD';
    const requiresCase=version?.kind==='CANDIDATE';
    fill('case',requiresCase?options.cases.filter(c=>c.id===version.case_id&&c.instance_id===value('instance')).map(c=>[c.id,c.id]):[['','No case required']]);field('case').disabled=!requiresCase;
    field('experiment').disabled=!requiresCase;field('experiment').required=requiresCase;
    if(requiresCase&&!value('experiment'))field('experiment').value=`test-experiment-${crypto.randomUUID()}`;
    const settings=options.settings.find(s=>s.instance_id===value('instance'));field('time-basis').textContent=settings?`Time basis: ${settings.time_basis}. Fill model: ${settings.fill_model_version}.`:'Execution settings are not yet registered; they must be confirmed before a run can be prepared.';
    normalizeCoverageBounds();
    review=null;field('confirm').checked=false;
    field('next').disabled=runnable.length===0;
  }
  function selection() {
    const split=value('dataset').lastIndexOf(':');
    return {strategy_id:value('strategy'),version_id:value('version'),expected_environment:value('environment'),instance_id:value('instance'),purpose:value('purpose'),permission_id:value('dataset').slice(0,split),partition_index:Number(value('dataset').slice(split+1)),interval:{start_utc:new Date(`${value('start')}Z`).toISOString(),end_utc:new Date(`${value('end')}Z`).toISOString()},warmup_interval:value('warmup')?{start_utc:new Date(`${value('warmup')}Z`).toISOString(),end_utc:new Date(`${value('start')}Z`).toISOString()}:null,build_mode:value('mode')||null,case_id:value('case')||null,experiment_id:field('experiment').disabled?null:value('experiment')||null};
  }
  function selectedPartition() {
    const datasetKey=value('dataset');
    const split=datasetKey.lastIndexOf(':');
    const permission=options.permissions.find(item=>item.permission_id===datasetKey.slice(0,split));
    return permission?.manifest.partitions[Number(datasetKey.slice(split+1))] || null;
  }
  function normalizeCoverageBounds() {
    const partition=selectedPartition();
    if(!partition)return;
    const normalized=normalizeHistoricalCoverage({partitionStartUtc:partition.start_utc,partitionEndUtc:partition.end_utc,scoredStartLocal:value('start'),scoredEndLocal:value('end'),warmupStartLocal:value('warmup')});
    field('start').min=normalized.minimum;field('start').max=normalized.maximum;
    field('end').min=normalized.minimum;field('end').max=normalized.maximum;
    field('warmup').min=normalized.minimum;field('warmup').max=value('start');field('warmup').value=normalized.warmup;
  }
  function coverageError() {
    normalizeCoverageBounds();
    const partition=selectedPartition();
    if(!partition)return 'Choose an available history source.';
    return normalizeHistoricalCoverage({partitionStartUtc:partition.start_utc,partitionEndUtc:partition.end_utc,scoredStartLocal:value('start'),scoredEndLocal:value('end'),warmupStartLocal:value('warmup')}).error;
  }
  function show() {
    form.querySelectorAll('fieldset').forEach((el,index)=>{el.hidden=index!==step;});
    form.querySelectorAll('.wizard-steps li').forEach((el,index)=>{el.toggleAttribute('aria-current',index===step);});
    field('back').hidden=step===0;field('next').textContent=step===2?'Reserve run':'Next';field('next').disabled=busy||!value('strategy')||(step===2&&(!review?.can_prepare||!field('confirm').checked));
  }
  const intervals=values=>values.length?values.map(v=>`${esc(v.start_utc.replace('.000Z','Z'))} to ${esc(v.end_utc.replace('.000Z','Z'))}`).join('<br>'):'None';
  form.addEventListener('change',event=>{
    if(event.target.id==='run-preset') {
      const preset=options.presets.find(p=>p.id===value('preset'));
      if(preset) {const s=preset.selection;for(const [name,v] of [['strategy',s.strategy_id],['version',s.version_id],['environment',s.expected_environment],['instance',s.instance_id],['purpose',s.purpose],['dataset',`${s.permission_id}:${s.partition_index}`],['mode',s.build_mode||''],['case',s.case_id||'']]){field(name).value=v;cascade();}field('start').value=s.interval.start_utc.slice(0,16);field('end').value=s.interval.end_utc.slice(0,16);field('warmup').value=s.warmup_interval?.start_utc.slice(0,16)||'';field('experiment').value=s.experiment_id||'';}
    } else if(['strategy','version','environment','instance','purpose','dataset'].some(n=>event.target===field(n)))cascade();
    else if(event.target!==field('confirm')&&event.target!==field('save-name')){review=null;if(['start','end','warmup'].some(n=>event.target===field(n)))normalizeCoverageBounds();}
    show();
  });
  field('back').addEventListener('click',()=>{step--;show();});
  form.noValidate=true;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    if(step===1){const message=coverageError();if(message){form.querySelector('.form-error').textContent=message;return;}}
    for(const el of form.querySelectorAll(`fieldset[data-step="${step}"] input,fieldset[data-step="${step}"] select`))if(!el.disabled&&!el.reportValidity())return;
    busy=true;show();form.querySelector('.form-error').textContent='';
    try {
      if(step===0)step=1;
      else if(step===1) {
        review=await post('run-manager/preview',{selection:selection()});
        field('review').innerHTML=`<p><strong>${esc(options.strategies.find(s=>s.strategy_id===review.selection.strategy_id)?.strategy_name)}</strong><br>${esc(review.instance.account_alias)} / ${esc(review.instance.execution_instance_id)}<br>${esc(human(review.selection.expected_environment))} / ${esc(human(review.selection.purpose))}</p><dl class="facts">${[['Version',`${human(review.version.kind)} / ${review.version.version}`],['Dataset role',human(review.partition)],['Dataset permission',human(review.learner_permission)],['Requested',intervals(review.requested)],['Already covered',intervals(review.already_covered)],['Missing',intervals(review.missing)],['Scored',intervals(review.scored_intervals)],['Warmup only',intervals(review.warmup_intervals)],['Protected overlap',intervals(review.protected)],['Reservation',review.instance_busy||review.conflicting_runs.join(', ')||'Available'],['Known gaps',review.known_gaps.map(esc).join('; ')||'None']].map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${k.includes('Version')?esc(v):v}</dd></div>`).join('')}</dl>${!review.can_prepare?'<p class="form-error">No new eligible interval or a conflicting reservation. Change the selection.</p>':''}<details><summary>Frozen hashes and coverage axes</summary><pre>${esc(JSON.stringify({manifest_key:review.manifest_key,review_hash:review.review_hash,manifest_hash:review.manifest_hash,code_hash:review.version.code_hash,coverage_key:review.coverage_key,axes_observed:review.axes_observed},null,2))}</pre>`;
        step=2;
      } else {
        if(!field('confirm').checked||!review?.can_prepare)return;
        if(value('save-name').trim())await post('run-manager/preset',{preset_id:`test-preset-${crypto.randomUUID()}`,name:value('save-name').trim(),selection:review.selection});
        const result=await post('run-manager/prepare',{run_id:`test-run-${crypto.randomUUID()}`,selection:review.selection,review_hash:review.review_hash,confirmed:true});
        modal.close();await onPrepared(result);
      }
    } catch(error) {form.querySelector('.form-error').textContent=errorText(error);if(error.code==='REVIEW_CHANGED'){review=null;step=1;}}
    finally {busy=false;show();}
  });
  cascade();if(strategyId){field('strategy').value=strategyId;cascade();}show();renderIcons();if(!modal.open)modal.showModal();
  modal.addEventListener('close',()=>modal.classList.remove('run-wizard'),{once:true});
}
