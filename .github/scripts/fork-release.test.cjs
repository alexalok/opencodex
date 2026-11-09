'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateSelection,validateAge,validateVersion} = require('./fork-release.cjs');
test('fork selection requires versioned release branch and exact SHA',()=>{
 assert.equal(validateSelection('releases/v2.90.0','a'.repeat(40)),'2.90.0');
 for(const branch of ['dev','main','backports/v2.90.0/foo','releases/v02.90.0','releases/v2.90.0/other']) assert.throws(()=>validateSelection(branch,'a'.repeat(40)));
 assert.throws(()=>validateSelection('releases/v2.90.0','abc'));
});
test('availability uses later official publication and full 168 hours',()=>{
 const now=Date.parse('2026-11-09T12:00:00Z');
 const release={tag_name:'v2.90.0',draft:false,prerelease:false,published_at:'2026-11-01T12:00:00Z'};
 const npm={versions:{'2.90.0':{}},time:{'2.90.0':'2026-11-02T12:00:00Z'}};
 validateAge(release,npm,'2.90.0',now);
 assert.throws(()=>validateAge(release,npm,'2.90.0',now-1));
 assert.throws(()=>validateAge({...release,prerelease:true},npm,'2.90.0',now));
 assert.throws(()=>validateAge(release,{...npm,time:{}},'2.90.0',now));
});
test('fork patch line cannot jump upstream base or lower npm latest',()=>{
 validateVersion('2.90.0','2.90.3','2.90.2');
 for(const v of ['2.91.0','2.89.9','2.90.1-preview.1']) assert.throws(()=>validateVersion('2.90.0',v,'2.90.0'));
 assert.throws(()=>validateVersion('2.90.0','2.90.3','2.91.0'));
 assert.throws(()=>validateVersion('2.90.0','2.90.3',undefined));
});

test('source fails closed on wrong repository, moving branch, or unmerged source',()=>{
 const {source}=require('./fork-release.cjs'), sha='a'.repeat(40), branch='releases/v2.90.0';
 const repo={id:1361227105,full_name:'alexalok/opencodex'}, ref={object:{type:'commit',sha}}, prs=[{merged_at:'2026-11-01T00:00:00Z',merge_commit_sha:sha,base:{ref:branch,repo:{id:1361227105}}}];
 const reader=(r=repo,f=ref,p=prs)=>path=>path.endsWith('/opencodex')?r:path.includes('/git/ref/')?f:p;
 assert.equal(source(branch,sha,reader()),'2.90.0');
 assert.throws(()=>source(branch,sha,reader({...repo,id:1})));
 assert.throws(()=>source(branch,sha,reader(repo,{object:{type:'commit',sha:'b'.repeat(40)}})));
 assert.throws(()=>source(branch,sha,reader(repo,ref,[])));
 assert.throws(()=>source(branch,sha,reader(repo,ref,[{...prs[0],base:{ref:'dev',repo:{id:1361227105}}}])));
});

test('ancestry ordering rejects reachable newer tags but not unrelated upstream tags',()=>{
 const {validateOrdering}=require('./fork-release.cjs');
 validateOrdering('2.90.1',['v2.90.0']);
 assert.throws(()=>validateOrdering('2.90.1',['v2.90.0','v2.91.0']));
 assert.throws(()=>validateOrdering('2.90.1',['v2.90.1']));
 validateOrdering('2.90.10',['v2.90.9']);
});
