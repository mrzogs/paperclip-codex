export async function openRunWizard({modal,request,post,esc,human,renderIcons,onPrepared,errorText,strategyId}) {
  const options=await request('run-manager/options');
  const host=document.querySelector('#modal-body');let step=0;let review=null;let busy=false;
  const option=(value,label)=>`<option value="${value===''?'':esc(value)}">${esc(label)}</option>`;
  const select=(name,label)=>`<div class="field"><label for="run-${name}">${label}</label><select id="run-${name}" name="${name}" required></select></div>`;
  const input=(name,label,type='datetime-local',required=true)=>`<div class="field"><label for="run-${name}">${label}</label><input id="run-${name}" name="${name}" type="${type}" ${required?'required':''}></div>`;
  modal.dataset.request='';modal.classList.add('run-wizard');
  host.innerHTML=`<form id="run-form"><div class="page-heading"><h2 id="modal-title">Prepare a run</h2><button type="button" class="icon" data-action="close-modal" title="Close" aria-label="Close"><i data-lucide="x"></i></button></div><p class="subline">TEST / Ingestion off / Sierra is started manually</p><ol class="wizard-steps"><li>Scope</li><li>Coverage</li><li>Review</li></ol><fieldset data-step="0"><div class="field"><label for="run-preset">Saved preset</label><select id="run-preset"><option value="">New run</option>${options.presets.map(p=>option(p.id,p.name)).join('')}</select></div><div class="wizard-grid">${select('strategy','Strategy')}${select('version','Registered version')}${select('environment','Expected environment')}${select('instance','Execution instance')}${select('purpose','Purpose')}${select('dataset','Approved TEST dataset')}</div><p id="run-role" class="subline"></p><p class="subline">Live real, Backtest and Import: not enabled.</p></fieldset><fieldset data-step="1" hidden><div class="wizard-grid">${input('start','Scored start (UTC)')}${input('end','Scored end (UTC)')}${input('warmup','Warmup start (UTC)','datetime-local',false)}${select('mode','History action')}${select('case','Case')}${input('experiment','Experiment reference','text',false)}</div><p id="run-time-basis" class="subline"></p></fieldset><fieldset data-step="2" hidden><div id="run-review"></div><label class="check-line"><input id="run-confirm" type="checkbox">I confirm this TEST scope and policy.</label><div class="field"><label for="run-save-name">Preset name (optional)</label><input id="run-save-name" maxlength="100"></div></fieldset><p class="form-error" role="alert"></p><div class="footer"><button type="button" id="run-back">Back</button><button type="submit" class="primary" id="run-next">Next</button></div></form>`;
  const form=host.querySelector('form');const field=name=>form.querySelector(`#run-${name}`);const value=name=>field(name).value;
  const fill=(name,rows,previous=value(name))=>{field(name).innerHTML=rows.map(([v,l])=>option(v,l)).join('');if(rows.some(([v])=>v===previous))field(name).value=previous;};
  const environmentRows=[['REPLAY','Replay'],['PAPER_FORWARD','Paper forward']];
  function cascade() {
    fill('strategy',options.strategies.map(s=>[s.strategy_id,s.strategy_name]));
    const versions=options.versions.filter(v=>v.strategy_id===value('strategy')&&!v.blocked);
    fill('version',versions.map(v=>[v.version_id,`${human(v.kind)} / ${v.version}`]));
    const version=versions.find(v=>v.version_id===value('version'));
    fill('environment',environmentRows);
    const instances=options.instances.filter(i=>i.strategy_id===value('strategy')&&i.version_binding===version?.version&&i.capabilities.includes(value('environment'))&&options.settings.some(s=>s.instance_id===i.execution_instance_id));
    fill('instance',instances.map(i=>[i.execution_instance_id,`${i.account_alias} / ${i.chartbook_id} / ${i.chart_id}`]));
    const rules=options.purposes.filter(p=>p[0]===value('environment'));
    fill('purpose', [...rules.filter(p=>version?.kind==='CANDIDATE'?['DEVELOPMENT_BACKTEST','RESEARCH_EXPERIMENT','VALIDATION','PROTECTED_HOLDOUT','SHADOW_FORWARD'].includes(p[1]):['LEARNING','HISTORICAL_BUILD'].includes(p[1])).map(p=>[p[1],p[4]]),...(version?.kind==='BASELINE'?[['NOT_ELIGIBLE','No Brain learning']]:[])]);
    const rule=rules.find(p=>p[1]===value('purpose'));
    const datasets=options.permissions.filter(p=>p.strategy_id===value('strategy')&&!p.expired&&p.purposes.includes(value('purpose'))).flatMap(p=>p.manifest.partitions.flatMap((part,index)=>!rule||part.partition===rule[2]?[[`${p.permission_id}:${index}`,`${p.manifest.dataset_manifest_id} / r${p.manifest.revision} / ${human(part.partition)}`]]:[]));
    fill('dataset',datasets);
    field('role').textContent=`Role and permission: ${rule?`${human(rule[2])} / ${human(rule[3])}`:'Declared dataset role / No learner use'}. Pending plans are not selectable.`;
    fill('mode',value('purpose')==='HISTORICAL_BUILD'?options.build_modes.map(m=>[m,human(m)]):[['','Not applicable']]);field('mode').disabled=value('purpose')!=='HISTORICAL_BUILD';
    const requiresCase=version?.kind==='CANDIDATE';
    fill('case',requiresCase?options.cases.filter(c=>c.id===version.case_id&&c.instance_id===value('instance')).map(c=>[c.id,c.id]):[['','No case required']]);field('case').disabled=!requiresCase;
    field('experiment').disabled=!requiresCase;field('experiment').required=requiresCase;
    if(requiresCase&&!value('experiment'))field('experiment').value=`test-experiment-${crypto.randomUUID()}`;
    const settings=options.settings.find(s=>s.instance_id===value('instance'));field('time-basis').textContent=settings?`Time basis: ${settings.time_basis}. Fill model: ${settings.fill_model_version}.`:'Execution settings not registered.';
    review=null;field('confirm').checked=false;
  }
  function selection() {
    const split=value('dataset').lastIndexOf(':');
    return {strategy_id:value('strategy'),version_id:value('version'),expected_environment:value('environment'),instance_id:value('instance'),purpose:value('purpose'),permission_id:value('dataset').slice(0,split),partition_index:Number(value('dataset').slice(split+1)),interval:{start_utc:new Date(`${value('start')}Z`).toISOString(),end_utc:new Date(`${value('end')}Z`).toISOString()},warmup_interval:value('warmup')?{start_utc:new Date(`${value('warmup')}Z`).toISOString(),end_utc:new Date(`${value('start')}Z`).toISOString()}:null,build_mode:value('mode')||null,case_id:value('case')||null,experiment_id:field('experiment').disabled?null:value('experiment')||null};
  }
  function show() {
    form.querySelectorAll('fieldset').forEach((el,index)=>{el.hidden=index!==step;});
    form.querySelectorAll('.wizard-steps li').forEach((el,index)=>{el.toggleAttribute('aria-current',index===step);});
    field('back').hidden=step===0;field('next').textContent=step===2?'Reserve run':'Next';field('next').disabled=busy||(step===2&&(!review?.can_prepare||!field('confirm').checked));
  }
  const intervals=values=>values.length?values.map(v=>`${esc(v.start_utc.replace('.000Z','Z'))} to ${esc(v.end_utc.replace('.000Z','Z'))}`).join('<br>'):'None';
  form.addEventListener('change',event=>{
    if(event.target.id==='run-preset') {
      const preset=options.presets.find(p=>p.id===value('preset'));
      if(preset) {const s=preset.selection;for(const [name,v] of [['strategy',s.strategy_id],['version',s.version_id],['environment',s.expected_environment],['instance',s.instance_id],['purpose',s.purpose],['dataset',`${s.permission_id}:${s.partition_index}`],['mode',s.build_mode||''],['case',s.case_id||'']]){field(name).value=v;cascade();}field('start').value=s.interval.start_utc.slice(0,16);field('end').value=s.interval.end_utc.slice(0,16);field('warmup').value=s.warmup_interval?.start_utc.slice(0,16)||'';field('experiment').value=s.experiment_id||'';}
    } else if(['strategy','version','environment','instance','purpose','dataset'].some(n=>event.target===field(n)))cascade();
    else if(event.target!==field('confirm')&&event.target!==field('save-name'))review=null;
    show();
  });
  field('back').addEventListener('click',()=>{step--;show();});
  form.noValidate=true;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    for(const el of form.querySelectorAll(`fieldset[data-step="${step}"] input,fieldset[data-step="${step}"] select`))if(!el.disabled&&!el.reportValidity())return;
    busy=true;show();form.querySelector('.form-error').textContent='';
    try {
      if(step===0)step=1;
      else if(step===1) {
        review=await post('run-manager/preview',{selection:selection()});
        field('review').innerHTML=`<p><strong>${esc(options.strategies.find(s=>s.strategy_id===review.selection.strategy_id)?.strategy_name)}</strong><br>${esc(review.instance.account_alias)} / ${esc(review.instance.execution_instance_id)}<br>${esc(human(review.selection.expected_environment))} / ${esc(human(review.selection.purpose))}</p><dl class="facts">${[['Version',`${human(review.version.kind)} / ${review.version.version}`],['Dataset role',human(review.partition)],['TEST permission',human(review.learner_permission)],['Requested',intervals(review.requested)],['Already covered',intervals(review.already_covered)],['Missing',intervals(review.missing)],['Scored',intervals(review.scored_intervals)],['Warmup only',intervals(review.warmup_intervals)],['Protected overlap',intervals(review.protected)],['Reservation',review.instance_busy||review.conflicting_runs.join(', ')||'Available'],['Known gaps',review.known_gaps.map(esc).join('; ')||'None']].map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${k.includes('Version')?esc(v):v}</dd></div>`).join('')}</dl>${!review.can_prepare?'<p class="form-error">No new eligible interval or a conflicting reservation. Change the selection.</p>':''}<details><summary>Frozen hashes and coverage axes</summary><pre>${esc(JSON.stringify({manifest_key:review.manifest_key,review_hash:review.review_hash,manifest_hash:review.manifest_hash,code_hash:review.version.code_hash,coverage_key:review.coverage_key,axes_observed:review.axes_observed},null,2))}</pre>`;
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
  cascade();if(strategyId){field('strategy').value=strategyId;cascade();}show();renderIcons();modal.showModal();
  modal.addEventListener('close',()=>modal.classList.remove('run-wizard'),{once:true});
}
