const strategy='cicd-vwap-pull-back-strategy';
const escape=value=>String(value ?? 'Unknown').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const label=value=>String(value || 'UNAVAILABLE').replaceAll('_',' ').toLowerCase();
const fact=(name,value)=>`<div><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`;
const badge=value=>`<span class="badge warn">${escape(label(value))}</span>`;
const reportNames={collector_health:'Collector health',cohort:'Descriptive cohort',exit_reconciliation:'Exit reconciliation',
  improvement_liveness:'Improvement liveness',discovery_admission:'Discovery admission',learning_rows:'Learning rows'};

export function unavailableVwapImprovementStatus(){
  return {strategy_id:strategy,evidence_ingestion:{status:'UNAVAILABLE'},strategy_improvement:{status:'STALLED',proof_status:'UNPROVED',
    evidence_class:'UNPROVED',owner:null,next_action:'Restore the configured evidence reader and authenticate the missing proof chain.',blockers:[]},
    observed_economics:{closed_trade_count:null,cohort_net:null,currency:'UNKNOWN'},verified_report_links:[]};
}

export async function fetchVwapImprovementStatus({signal}={}){
  const response=await fetch('/api/vwap-improvement-monitor/status',{credentials:'same-origin',cache:'no-store',signal});
  if(!response.ok)throw new Error('VWAP_EVIDENCE_STATUS_UNAVAILABLE');
  const value=await response.json();
  if(value.strategy_id!==strategy || !value.evidence_ingestion || !value.strategy_improvement)throw new Error('VWAP_EVIDENCE_STATUS_INVALID');
  return value;
}

export function renderVwapImprovementPanel(value){
  const status=value?.strategy_id===strategy?value:unavailableVwapImprovementStatus();
  const ingestion=status.evidence_ingestion || {},loop=status.strategy_improvement || {},economics=status.observed_economics || {};
  const softwareOnly=loop.evidence_class==='SOFTWARE_ONLY';
  const links=(status.verified_report_links || []).filter(link=>Object.hasOwn(reportNames,link.kind)
    && /^[a-f0-9]{64}$/i.test(link.sha256 || '')
    && new RegExp(`^/api/workflow/vwap-improvement-monitor/reports/${link.kind}\\?publication_sha256=[a-f0-9]{64}$`,'i').test(link.href || ''));
  const blockers=Array.isArray(loop.blockers)?loop.blockers.slice(0,12):[];
  return `<section id="vwap-improvement-evidence-panel" aria-label="VWAP evidence and improvement">
    <div class="section-heading"><h2>Evidence ingestion</h2>${badge(ingestion.status)}</div>
    <p>Published report integrity and collection health are shown separately from strategy improvement.</p>
    ${softwareOnly?'<p class="notice">Software-only fixture evidence. No physical Replay or profitable strategy acceptance is established.</p>':''}
    <dl class="facts">${fact('Observed cohort closed trades',economics.closed_trade_count ?? 'Unknown')}
      ${fact('Observed cohort net',economics.cohort_net ?? 'Unknown')}${fact('Currency',economics.currency || 'UNKNOWN')}
      ${fact('Cohort chart dates',economics.chart_start && economics.chart_end?`${economics.chart_start} to ${economics.chart_end}`:'Unknown')}
      ${fact('Open trades excluded',economics.open_excluded ?? 'Unknown')}</dl>
    <p class="muted">Descriptive observations; these figures do not establish an improvement verdict.</p>
    <div class="section-heading"><h2>Strategy improvement loop</h2>${badge(loop.status || 'STALLED')}</div>
    <dl class="facts">${fact('Proof status',loop.proof_status || 'UNPROVED')}${fact('Reported stage (unverified)',loop.reported_stage || 'Unknown')}
      ${fact('Reported owner',loop.owner || 'Not recorded')}${fact('Next action',loop.next_action || 'Obtain and authenticate the missing evidence.')}</dl>
    ${blockers.length?`<ul>${blockers.map(blocker=>`<li>${escape(blocker.code || 'Evidence gap')}${blocker.owner?` — ${escape(blocker.owner)}`:''}${blocker.detail?`: ${escape(blocker.detail)}`:''}${blocker.next_action?` ${escape(blocker.next_action)}`:''}</li>`).join('')}</ul>`:''}
    ${links.length?`<p>Retained reports: ${links.map(link=>`<a href="${escape(link.href)}" download>${escape(reportNames[link.kind])}</a>`).join(' · ')}</p>`:''}
    <p class="muted">Paper deployment requires its separate approval and installed-package verification.</p>
  </section>`;
}
