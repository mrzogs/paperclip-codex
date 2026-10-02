import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, equalSecret, future, ROLES } from './common.mjs';

// Read-only operator check. Never echo config content, credentials or remote bodies.
export async function checkProvider({base, identityId=null, environment=process.env}) {
  const url=new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
      !(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw new Error('TRUSTED_BASE_URL_REQUIRED');
  }
  const result={schema_version:'ocean-provider-check/v1',base_url:url.origin,read_only:true,
    workflow_enabled_reference_present:environment.OCEAN_WORKFLOW_ENABLED==='1',
    config_reference_present:Boolean(environment.OCEAN_WORKFLOW_CONFIG),checks:[],status:'BLOCKED'};
  let config=null;
  if (environment.OCEAN_WORKFLOW_CONFIG) {
    if (!path.isAbsolute(environment.OCEAN_WORKFLOW_CONFIG)) throw new Error('ABSOLUTE_CONFIG_REFERENCE_REQUIRED');
    try { config=JSON.parse(fs.readFileSync(environment.OCEAN_WORKFLOW_CONFIG,'utf8')); }
    catch { throw new Error('CONFIG_UNREADABLE'); }
    result.config_sha256=digest(fs.readFileSync(environment.OCEAN_WORKFLOW_CONFIG));
  }
  const headers={};
  if (identityId) {
    if (!config?.allowed_origins?.includes(url.origin)) throw new Error('SECRET_DELIVERY_ORIGIN_UNBOUND');
    const identity=config.identities?.find(item=>item.identity_id===identityId);
    if (!identity || identity.provider!=='OCEAN_TRADING' || identity.namespace!=='TEST' || !ROLES[identity.role]) throw new Error('PROVIDER_IDENTITY_UNBOUND');
    if (!/^OCEAN_[A-Z0-9_]+_TOKEN$/.test(identity.credential_ref)) throw new Error('PROVIDER_REFERENCE_INVALID');
    const value=environment[identity.credential_ref];
    if (!value?.startsWith(`ocean_service_v1.${identity.identity_id}.`) || !equalSecret(digest(value),identity.credential_hash)) throw new Error('CREDENTIAL_REFERENCE_UNRESOLVED');
    if (identity.revoked || !future(identity.expires_at_utc)) throw new Error('CREDENTIAL_EXPIRED_OR_REVOKED');
    headers.Authorization=`Bearer ${value}`;
    result.local_identity={identity_id:identity.identity_id,role:identity.role,credential_ref:identity.credential_ref,strategy_ids:identity.strategy_ids,instance_ids:identity.instance_ids,expires_at_utc:identity.expires_at_utc};
    result.identity_evidence='Local issuer metadata/hash plus remote credential acceptance; status is not an identity introspection or a complete scope test';
  }
  for (const route of ['/','/api/workflow/status']) {
    try {
      const response=await fetch(url.origin+route,{headers:route==='/'?{}:headers,redirect:'error',signal:AbortSignal.timeout(8000)});
      const check={route,http_status:response.status};
      if (route.endsWith('/status') && response.status===200) {
        const body=await response.json();
        check.api_version=body.api_version;check.contract_release=body.contract_release;
        check.namespace=body.namespace;check.brain_submission=body.brain_submission;
        check.live_real=body.live_real;check.dispatch_worker=body.dispatch_worker;
      } else await response.body?.cancel();
      result.checks.push(check);
    } catch { result.checks.push({route,error:'REQUEST_FAILED_OR_TIMED_OUT'}); }
  }
  const api=result.checks[1];
  if (identityId && api.http_status===200 && api.api_version==='ocean-workflow/v1' && api.contract_release==='2.1.0' && api.namespace==='TEST' && api.brain_submission==='OFF' && api.live_real==='DISABLED' && api.dispatch_worker==='OFF') result.status='AUTHENTICATED_TEST_ENDPOINT_AVAILABLE';
  result.operational_integration_complete=false;
  return result;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const args=process.argv.slice(2);const allowed=new Set(['--base','--identity']);const options={};
    for (let i=0;i<args.length;i+=2) {
      if (!allowed.has(args[i]) || !args[i+1] || options[args[i]]) throw new Error('EXPECTED_BASE_AND_OPTIONAL_IDENTITY_ONLY');
      options[args[i]]=args[i+1];
    }
    const result=await checkProvider({base:options['--base'],identityId:options['--identity']});
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.status==='AUTHENTICATED_TEST_ENDPOINT_AVAILABLE'?0:2;
  } catch(error) {
    const known=/^[A-Z_]+$/.test(error.message)?error.message:'PROVIDER_CHECK_FAILED';
    console.log(JSON.stringify({status:'BLOCKED',error:known,read_only:true}));process.exitCode=2;
  }
}
