'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const AUTHORITY={actor:'alexalok',triggeringActor:'alexalok'};
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
test('GitHub-only fork patch line is independent of npm latest',()=>{
 validateVersion('2.96.0','2.96.5');
 validateVersion('2.96.0','2.96.5','2.100.0');
 for(const v of ['2.97.0','2.95.9','2.96.1-preview.1']) assert.throws(()=>validateVersion('2.96.0',v));
});

test('source fails closed on wrong repository, moving branch, or unmerged source',()=>{
 const implementation=require('./fork-release.cjs'); const source=(branch,sha,read)=>implementation.source(branch,sha,read,AUTHORITY), sha='a'.repeat(40), branch='releases/v2.90.0';
 const repo={id:1361227105,full_name:'alexalok/opencodex'}, ref={object:{type:'commit',sha}}, prs=[{number:1,merged_by:{login:'alexalok',type:'User'},merged_at:'2026-11-01T00:00:00Z',merge_commit_sha:sha,base:{ref:branch,repo:{id:1361227105}}}];
 const reader=(r=repo,f=ref,p=prs)=>path=>path.endsWith('/opencodex')?r:path.includes('/git/ref/')?f:path.includes('/pulls/1')?p[0]:p;
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


function serviceEvidenceFixture(failure, kind = 'service', transformJobs = jobs => jobs) {
 const candidate='a'.repeat(40), newest='b'.repeat(40), older='c'.repeat(40), badTree='d'.repeat(40), goodTree='e'.repeat(40), blob='f'.repeat(40);
 const branch='releases/v2.90.0', repo={id:1361227105,full_name:'alexalok/opencodex'}, calls=[];
 const run=(id,head_sha)=>({id,head_sha,head_branch:'dev',run_attempt:1,workflow_id:5,event:'workflow_dispatch',status:'completed',conclusion:'success',repository:repo,head_repository:repo,actor:{login:'alexalok',type:'User'},triggering_actor:{login:'alexalok',type:'User'}});
 const filename=kind==='ci'?'ci.yml':'service-lifecycle.yml';
 const policies=[{kind,version:1,files:{[`.github/workflows/${filename}`]:blob}}];
 const read=path=>{
  calls.push(path);
  if(path==='repos/alexalok/opencodex')return repo;
  if(path.includes('/git/ref/heads/'))return {object:{type:'commit',sha:candidate}};
  if(path.includes(`/commits/${candidate}/pulls?`))return [{number:1,merged_at:'2026-11-01',merge_commit_sha:candidate,base:{ref:branch,repo}}];
  if(path.endsWith('/pulls/1'))return {number:1,merged_at:'2026-11-01',merge_commit_sha:candidate,base:{ref:branch,repo},merged_by:{login:'alexalok',type:'User'}};
  if(path.endsWith(`/actions/workflows/${filename}`))return {id:5,path:`.github/workflows/${filename}`};
  if(path.includes('/workflows/5/runs?'))return kind==='ci'
   ? {total_count:1,workflow_runs:[{...run(1,candidate),head_branch:branch,display_title:`ocx-ci-v1 lane=all sha=${candidate}`}]}
   : {total_count:2,workflow_runs:[run(2,newest),run(1,older)]};
  if(path.endsWith(`/git/commits/${candidate}`))return {tree:{sha:goodTree}};
  if(path.endsWith(`/git/commits/${newest}`)) {
   if(failure==='api')throw Error('GitHub API request failed (403)');
   if(failure==='unknown')throw Error('unexpected transport error');
   return {tree:{sha:failure==='jobs'?goodTree:badTree}};
  }
  if(path.endsWith(`/git/commits/${older}`))return {tree:{sha:failure==='all-unapproved'?badTree:goodTree}};
  if(path.includes('/git/trees/')) {
   if(failure==='tree')return {truncated:true,tree:[]};
   const tree=path.split('/').at(-1);
   return {truncated:false,tree:[{path:'.github',type:'tree',sha:tree},{path:'workflows',type:'tree',sha:tree},{path:filename,type:'blob',mode:'100644',sha:tree===goodTree?blob:'0'.repeat(40)}]};
  }
  if(path.includes('/attempts/1/jobs?')) {
   const {CI_JOBS,serviceJobs}=require('./release-evidence.cjs');
   const jobs=transformJobs((kind==='ci'?CI_JOBS:serviceJobs(candidate)).map(name=>({name,status:'completed',conclusion:'success'})));
   return {total_count:failure==='jobs'?jobs.length+1:jobs.length,jobs};
  }
  throw Error('unexpected API path: '+path);
 };
 return {candidate,branch,read,policies,calls,older};
}
test('fork service evidence skips a newer unapproved policy and selects older approved evidence',async()=>{
 const f=serviceEvidenceFixture();
 assert.deepEqual(await require('./fork-release.cjs').evidence(f.branch,f.candidate,'service',f.read,f.policies,AUTHORITY),{sourceSha:f.candidate,ciRunId:1});
 assert.ok(!f.calls.some(path=>path.includes('/runs/2/attempts/')));
 assert.ok(f.calls.some(path=>path.includes('/runs/1/attempts/')));
});
test('fork evidence does not skip API errors, incomplete trees/jobs, or unknown errors',async()=>{
 for(const [failure,message] of [['api','GitHub API request failed (403)'],['tree','incomplete tree'],['jobs','incomplete fork jobs'],['unknown','unexpected transport error']]) {
  const f=serviceEvidenceFixture(failure);
  await assert.rejects(require('./fork-release.cjs').evidence(f.branch,f.candidate,'service',f.read,f.policies,AUTHORITY),{message});
  assert.ok(!f.calls.some(path=>path.endsWith(`/git/commits/${f.older}`)),failure);
 }
});

test('fork evidence refuses a scan with no approved policy',async()=>{
 const f=serviceEvidenceFixture('all-unapproved');
 await assert.rejects(require('./fork-release.cjs').evidence(f.branch,f.candidate,'service',f.read,f.policies,AUTHORITY),{message:'no qualifying fork service evidence'});
 assert.ok(!f.calls.some(path=>path.includes('/attempts/')));
});

test('fork source rejects writer dispatches, untrusted reruns and non-owner PR mergers',()=>{
 const {source}=require('./fork-release.cjs'), candidate='a'.repeat(40), branch='releases/v2.90.0';
 for(const authority of [{},{actor:'writer',triggeringActor:'writer'},{actor:'alexalok',triggeringActor:'writer'},{actor:'writer',triggeringActor:'alexalok'},{actor:'lidge-jun',triggeringActor:'lidge-jun'}]) {
  assert.throws(()=>source(branch,candidate,()=>{throw Error('API must not run before authority check');},authority),/require an authorized release account/);
 }
 for(const merged_by of [undefined,{login:'writer',type:'User'},{login:'alexalok',type:'Bot'},{login:'Ingwannu',type:'User'},{login:'alexalok',type:'User'},{login:'jack-o-mania',type:'User'}]) {
  const repo={id:1361227105,full_name:'alexalok/opencodex'};
  const pr={number:8,merged_at:'2026-11-01',merge_commit_sha:candidate,base:{ref:branch,repo},user:{login:'writer'},merged_by,approved:true};
  const read=path=>path.endsWith('/opencodex')?repo:path.includes('/git/ref/')?{object:{type:'commit',sha:candidate}}:path.includes('/commits/')?[{...pr,merged_by:{login:'alexalok',type:'User'}}]:pr;
  if(['alexalok','jack-o-mania'].includes(merged_by?.login) && merged_by?.type==='User')assert.equal(source(branch,candidate,read,AUTHORITY),'2.90.0');
  else assert.throws(()=>source(branch,candidate,read,AUTHORITY),/must be merged by an authorized release account/);
 }
});
test('fork qualification rejects writer or missing actors on otherwise approved evidence',async()=>{
 for(const field of ['actor','triggering_actor']) for(const user of [undefined,{login:'writer',type:'User'},{login:'alexalok',type:'Bot'}]) {
  const f=serviceEvidenceFixture();
  const read=path=>{
   const value=f.read(path);
   if(path.includes('/workflows/5/runs?')) for(const run of value.workflow_runs)run[field]=user;
   return value;
  };
  await assert.rejects(require('./fork-release.cjs').evidence(f.branch,f.candidate,'service',read,f.policies,AUTHORITY),/no qualifying/);
  assert.ok(!f.calls.some(path=>path.includes('/git/commits/')));
 }
});

test('production CLI rejects missing or writer authority before any GitHub request',()=>{
 const {spawnSync}=require('node:child_process');
 for(const actors of [{},{GITHUB_ACTOR:'writer',GITHUB_TRIGGERING_ACTOR:'writer'},{GITHUB_ACTOR:'alexalok',GITHUB_TRIGGERING_ACTOR:'writer'}]) {
  const result=spawnSync(process.execPath,[require.resolve('./fork-release.cjs'),'source','a'.repeat(40)],{
   encoding:'utf8',env:{PATH:'',GITHUB_REPOSITORY:'alexalok/opencodex',FORK_RELEASE_BRANCH:'releases/v2.90.0',...actors},
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/dispatch and rerun require an authorized release account/);
  assert.doesNotMatch(result.stderr,/spawnSync gh|ENOENT/);
 }
});

test('fork cannot enter any npm packaging or publishing job',()=>{
 const workflow=require('node:fs').readFileSync(require('node:path').join(__dirname,'../workflows/release.yml'),'utf8');
 for(const name of ['package-npm','verify-npm','publish']) {
  const job=workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.ok(job,name);
  assert.match(job,/if: \$\{\{.*github.repository != 'alexalok\/opencodex'/,name);
  const condition=job.split('\n').find(line=>line.trim().startsWith('if:'));
  assert.ok(!condition.includes('||'),name);
 }
});

test('owner-authorized release account can dispatch and rerun',()=>{
 const {assertReleaseAuthority}=require('./fork-release.cjs');
 for(const actor of ['alexalok','jack-o-mania']) for(const triggeringActor of ['alexalok','jack-o-mania']) assert.doesNotThrow(()=>assertReleaseAuthority({actor,triggeringActor}));
});

// Pass the trusted workflow flag explicitly so these cases never mutate process.env.
test('fork platform profiles preserve the full roster unless macOS is explicitly disabled',()=>{
 const {requiredJobs}=require('./fork-release.cjs'), {CI_JOBS,serviceJobs}=require('./release-evidence.cjs');
 const candidate='a'.repeat(40);
 for(const kind of ['ci','service']) {
  const all=kind==='ci'?CI_JOBS:serviceJobs(candidate);
  for(const flag of ['', 'false', 'FALSE', '1', ' true ']) assert.deepEqual(requiredJobs(kind,candidate,flag),all);
  for(const flag of ['true','TRUE','TrUe']) assert.deepEqual(requiredJobs(kind,candidate,flag),all.filter(name=>!name.includes('macos')));
 }
 const required=requiredJobs('ci',candidate,'true');
 assert.equal(required.filter(name=>/^test \d/.test(name)).length,5);
 assert.equal(required.filter(name=>/^windows \d/.test(name)).length,11);
 assert.ok(required.includes('ci'));
 assert.deepEqual(requiredJobs('service',candidate,'true'),['validate source',`linux-systemd ${candidate}`,`windows-schtasks ${candidate}`]);
});

test('fork evidence accepts skipped or absent macOS jobs only with the trusted disable flag',async()=>{
 const {evidence}=require('./fork-release.cjs');
 for(const kind of ['ci','service']) for(const omit of [false,true]) {
  const f=serviceEvidenceFixture(undefined,kind,jobs=>omit?jobs.filter(job=>!job.name.includes('macos')):jobs.map(job=>job.name.includes('macos')?{...job,conclusion:'skipped'}:job));
  for(const flag of ['true','TRUE']) assert.deepEqual(await evidence(f.branch,f.candidate,kind,f.read,f.policies,AUTHORITY,flag),{sourceSha:f.candidate,ciRunId:1});
  for(const flag of ['', 'false']) await assert.rejects(evidence(f.branch,f.candidate,kind,f.read,f.policies,AUTHORITY,flag),/no qualifying fork/);
 }
 for(const kind of ['ci','service']) {
  const f=serviceEvidenceFixture(undefined,kind);
  assert.deepEqual(await evidence(f.branch,f.candidate,kind,f.read,f.policies,AUTHORITY,''),{sourceSha:f.candidate,ciRunId:1});
 }
});

test('disabling macOS still requires every non-macOS job to complete successfully',async()=>{
 const {evidence}=require('./fork-release.cjs'), {CI_JOBS,serviceJobs}=require('./release-evidence.cjs');
 for(const kind of ['ci','service']) for(const name of (kind==='ci'?CI_JOBS:serviceJobs('a'.repeat(40))).filter(name=>!name.includes('macos'))) {
  for(const conclusion of ['missing','failure','skipped']) {
   const f=serviceEvidenceFixture(undefined,kind,jobs=>jobs.filter(job=>!job.name.includes('macos') && !(job.name===name && conclusion==='missing')).map(job=>job.name===name?{...job,conclusion}:job));
   await assert.rejects(evidence(f.branch,f.candidate,kind,f.read,f.policies,AUTHORITY,'true'),/no qualifying fork/,`${kind}: ${name}: ${conclusion}`);
  }
 }
});

test('production platform selection reads the trusted workflow environment without a caller override',()=>{
 const {spawnSync}=require('node:child_process'), script="const {requiredJobs}=require(process.argv[1]); console.log(JSON.stringify(['ci','service'].map(kind=>requiredJobs(kind,'a'.repeat(40)))));";
 const {CI_JOBS,serviceJobs}=require('./release-evidence.cjs');
 for(const flag of [undefined,'false','TrUe']) {
  const result=spawnSync(process.execPath,['-e',script,require.resolve('./fork-release.cjs')],{
   encoding:'utf8',env:flag===undefined?{}:{OCX_DISABLE_MACOS_CI:flag},
  });
  assert.equal(result.status,0,result.stderr);
  const expected=[CI_JOBS,serviceJobs('a'.repeat(40))].map(jobs=>flag==='TrUe'?jobs.filter(name=>!name.includes('macos')):jobs);
  assert.deepEqual(JSON.parse(result.stdout),expected);
 }
});
