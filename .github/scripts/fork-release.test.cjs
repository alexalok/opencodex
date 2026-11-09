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


function serviceEvidenceFixture(failure) {
 const candidate='a'.repeat(40), newest='b'.repeat(40), older='c'.repeat(40), badTree='d'.repeat(40), goodTree='e'.repeat(40), blob='f'.repeat(40);
 const branch='releases/v2.90.0', repo={id:1361227105,full_name:'alexalok/opencodex'}, calls=[];
 const run=(id,head_sha)=>({id,head_sha,head_branch:'dev',run_attempt:1,workflow_id:5,event:'workflow_dispatch',status:'completed',conclusion:'success',repository:repo,head_repository:repo});
 const policies=[{kind:'service',version:1,files:{'.github/workflows/service-lifecycle.yml':blob}}];
 const read=path=>{
  calls.push(path);
  if(path==='repos/alexalok/opencodex')return repo;
  if(path.includes('/git/ref/heads/'))return {object:{type:'commit',sha:candidate}};
  if(path.includes(`/commits/${candidate}/pulls?`))return [{merged_at:'2026-11-01',merge_commit_sha:candidate,base:{ref:branch,repo}}];
  if(path.endsWith('/actions/workflows/service-lifecycle.yml'))return {id:5,path:'.github/workflows/service-lifecycle.yml'};
  if(path.includes('/workflows/5/runs?'))return {total_count:2,workflow_runs:[run(2,newest),run(1,older)]};
  if(path.endsWith(`/git/commits/${newest}`)) {
   if(failure==='api')throw Error('GitHub API request failed (403)');
   if(failure==='unknown')throw Error('unexpected transport error');
   return {tree:{sha:failure==='jobs'?goodTree:badTree}};
  }
  if(path.endsWith(`/git/commits/${older}`))return {tree:{sha:failure==='all-unapproved'?badTree:goodTree}};
  if(path.includes('/git/trees/')) {
   if(failure==='tree')return {truncated:true,tree:[]};
   const tree=path.split('/').at(-1);
   return {truncated:false,tree:[{path:'.github',type:'tree',sha:tree},{path:'workflows',type:'tree',sha:tree},{path:'service-lifecycle.yml',type:'blob',mode:'100644',sha:tree===goodTree?blob:'0'.repeat(40)}]};
  }
  if(path.includes('/attempts/1/jobs?')) {
   const jobs=require('./release-evidence.cjs').serviceJobs(candidate).map(name=>({name,status:'completed',conclusion:'success'}));
   return {total_count:failure==='jobs'?jobs.length+1:jobs.length,jobs};
  }
  throw Error('unexpected API path: '+path);
 };
 return {candidate,branch,read,policies,calls,older};
}
test('fork service evidence skips a newer unapproved policy and selects older approved evidence',async()=>{
 const f=serviceEvidenceFixture();
 assert.deepEqual(await require('./fork-release.cjs').evidence(f.branch,f.candidate,'service',f.read,f.policies),{sourceSha:f.candidate,ciRunId:1});
 assert.ok(!f.calls.some(path=>path.includes('/runs/2/attempts/')));
 assert.ok(f.calls.some(path=>path.includes('/runs/1/attempts/')));
});
test('fork evidence does not skip API errors, incomplete trees/jobs, or unknown errors',async()=>{
 for(const [failure,message] of [['api','GitHub API request failed (403)'],['tree','incomplete tree'],['jobs','incomplete fork jobs'],['unknown','unexpected transport error']]) {
  const f=serviceEvidenceFixture(failure);
  await assert.rejects(require('./fork-release.cjs').evidence(f.branch,f.candidate,'service',f.read,f.policies),{message});
  assert.ok(!f.calls.some(path=>path.endsWith(`/git/commits/${f.older}`)),failure);
 }
});

test('fork evidence refuses a scan with no approved policy',async()=>{
 const f=serviceEvidenceFixture('all-unapproved');
 await assert.rejects(require('./fork-release.cjs').evidence(f.branch,f.candidate,'service',f.read,f.policies),{message:'no qualifying fork service evidence'});
 assert.ok(!f.calls.some(path=>path.includes('/attempts/')));
});
