import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {manifestStatePath} from './manifest-state-path.mjs';
test('ordinary or absent mutable state retains the current dashboard manifest',()=>{
 const dashboard=path.resolve('current/dashboard'),expected=path.join(dashboard,'dashboard-data.json');
 assert.equal(manifestStatePath(dashboard,{exists:()=>false}),expected);
 assert.equal(manifestStatePath(dashboard,{exists:()=>true,realpath:x=>x}),expected);
 assert.equal(manifestStatePath(dashboard,{exists:()=>true,realpath:()=>{throw Error('unavailable');}}),expected);
});
test('a retained monitor data directory keeps file and database publication coherent',()=>{
 const dashboard=path.resolve('next/dashboard'),publisher=path.resolve('previous/dashboard');
 let checked;
 assert.equal(manifestStatePath(dashboard,{exists:()=>true,realpath:x=>{checked=x;return path.join(publisher,'data');}}),path.join(publisher,'dashboard-data.json'));
 assert.equal(checked,path.join(dashboard,'data'));
});
