import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequestTiming,routeFamily} from './request-timing.mjs';

test('route metadata excludes queries, IDs and arbitrary static paths',()=>{
  assert.equal(routeFamily('/api/manifest?token=PRIVATE'),'/api/manifest');
  assert.equal(routeFamily('/api/workflow/view/strategies/private-id?secret=x'),'/api/workflow/view/strategies');
  assert.equal(routeFamily('/improvement/cases/private-id'),'/improvement/cases');
  assert.equal(routeFamily('/private/arbitrary'), 'STATIC');
  assert.equal(routeFamily('/api/PRIVATE'), '/api/other');
  assert.equal(routeFamily('/api/workflow/view/PRIVATE'), '/api/workflow/view/other');
});
test('timing preserves return/throw and reports the exact request/span without content',()=>{
  let now=0;const events=[];const timing=createRequestTiming({clock:()=>now,utc:()=> 'test',log:x=>events.push(x),thresholdMs:50});
  const res=new EventEmitter();res.statusCode=200;timing.start();
  try{
    const result=timing.request({url:'/api/manifest?token=PRIVATE',headers:{authorization:'PRIVATE'}},res,()=>
      timing.sync('manifest.sqlite.child',()=>{now+=80;return 'preserved';}));
    assert.equal(result,'preserved');res.emit('finish');res.emit('close');
    assert.equal(events.filter(x=>x.kind==='request').length,1);
    assert.equal(events[0].route,'/api/manifest');assert.equal(events[0].duration_ms,80);
    const error=Error('PRIVATE');assert.throws(()=>timing.sync('throwing',()=>{throw error;}),e=>e===error);
    assert.ok(!JSON.stringify(events).includes('PRIVATE'));
    now=2200;timing.sample();assert.equal(events.at(-1).kind,'event_loop_delay');
    assert.equal(events.at(-1).spans.find(x=>x.label==='manifest.sqlite.child').count,1);
  }finally{timing.stop();}
});
test('diagnostics are inactive before start and logger failure never changes behavior',()=>{
  const timing=createRequestTiming({thresholdMs:0,log:()=>{throw Error('log failure');}});
  assert.equal(timing.sync('disabled',()=>42),42);timing.start();
  try{assert.equal(timing.sync('enabled',()=>43),43);}finally{timing.stop();}
});
