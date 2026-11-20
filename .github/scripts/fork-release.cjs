'use strict';

// Fork policy runs from the trusted dev workflow checkout, never from the candidate.
const {execFileSync} = require('node:child_process');
const {compareVersions} = require('./release-history.cjs');
const FORK = 'alexalok/opencodex', ID = 1361227105, RELEASE_ACTORS = new Set(['alexalok', 'jack-o-mania']);
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^releases\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function must(value, message) { if (!value) throw Error(message); }
function validateSelection(branch, source) {
  must(BRANCH.test(branch || '') && SHA.test(source || ''), 'fork requires explicit releases/vX.Y.Z branch and full source SHA');
  return branch.slice('releases/v'.length);
}
function validateAge(release, registry, base, now = Date.now()) {
  must(release?.tag_name === `v${base}` && release.draft === false && release.prerelease === false, 'base must be a published stable upstream release');
  must(registry?.versions?.[base] && !registry.versions[base].deprecated, 'upstream registry version absent or withdrawn');
  const githubDate = Date.parse(release.published_at), npmDate = Date.parse(registry.time?.[base]);
  must(Number.isFinite(githubDate) && Number.isFinite(npmDate) && Number.isFinite(now) && now - Math.max(githubDate,npmDate) >= 168 * 3600000, 'upstream base availability must be verifiable and at least 168 hours old');
}
function validateVersion(base, version) {
  must(/^\d+\.\d+\.\d+$/.test(version || '') && version.split('.').slice(0,2).join('.') === base.split('.').slice(0,2).join('.') && compareVersions(version,base) >= 0, 'fork version must remain on selected base patch line');
}
function validateOrdering(version, tags) {
  for (const tag of tags) {
    const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
    if (match) must(compareVersions(version,match[1]) > 0,'candidate does not outrank release ancestry');
  }
}
function git(...args) { return execFileSync('git',args,{encoding:'utf8'}).trim(); }
function api(path) { return JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',maxBuffer:32*1024*1024})); }
async function registry() {
  const response = await fetch('https://registry.npmjs.org/%40bitkyc08%2Fopencodex',{redirect:'error',signal:AbortSignal.timeout(15000)});
  must(response.ok,'npm registry lookup failed'); return response.json();
}
// This policy belongs to the trusted dev checkout, never a candidate-controlled roster.
function assertReleaseAuthority(authority) {
  must(RELEASE_ACTORS.has(authority?.actor) && RELEASE_ACTORS.has(authority?.triggeringActor),
    'fork release dispatch and rerun require an authorized release account');
}
function currentAuthority() { return {actor:process.env.GITHUB_ACTOR,triggeringActor:process.env.GITHUB_TRIGGERING_ACTOR}; }
function releaseUser(user) { return RELEASE_ACTORS.has(user?.login) && user?.type === 'User'; }
function source(branch, candidate, read = api, authority = currentAuthority()) {
  assertReleaseAuthority(authority);
  const base = validateSelection(branch,candidate);
  const repo = read(`repos/${FORK}`); must(repo.id === ID && repo.full_name === FORK,'fork identity mismatch');
  const ref = read(`repos/${FORK}/git/ref/heads/${branch}`);
  must(ref.object?.type === 'commit' && ref.object.sha === candidate,'release branch moved or source is not its exact tip');
  const prs = read(`repos/${FORK}/commits/${candidate}/pulls?per_page=100`);
  const matches = pr => pr.merged_at && pr.merge_commit_sha === candidate && pr.base?.ref === branch && pr.base?.repo?.id === ID;
  const selected = prs.find(pr => matches(pr) && Number.isSafeInteger(pr.number) && pr.number > 0);
  must(selected,'source must be a merged PR commit on selected release branch');
  // Commit-associated PR summaries need not include merged_by. Read the authoritative detail.
  const detail = read(`repos/${FORK}/pulls/${selected.number}`);
  must(detail.number === selected.number && matches(detail) && releaseUser(detail.merged_by),
    'release source PR must be merged by an authorized release account');
  return base;
}
// The flag comes from the trusted release workflow's repository-variable env,
// never from candidate metadata or the qualifying run. Actions ignores case.
function requiredJobs(kind,candidate,disableMacos = process.env.OCX_DISABLE_MACOS_CI) {
  const {CI_JOBS,serviceJobs} = require('./release-evidence.cjs');
  const jobs = kind === 'ci' ? CI_JOBS : serviceJobs(candidate);
  return String(disableMacos).toLowerCase() === 'true' ? jobs.filter(name => !name.includes('macos')) : jobs;
}
async function evidence(branch,candidate,kind,read = api,policies = require('./release-evidence-policy.json'),authority = currentAuthority(),disableMacos = process.env.OCX_DISABLE_MACOS_CI) {
  source(branch,candidate,read,authority);
  const filename = kind === 'service' ? 'service-lifecycle.yml' : 'ci.yml';
  const wf = read(`repos/${FORK}/actions/workflows/${filename}`);
  must(wf.path === `.github/workflows/${filename}` && Number.isSafeInteger(wf.id),'workflow identity mismatch');
  const params = new URLSearchParams({event:'workflow_dispatch',branch:kind === 'ci' ? branch : 'dev',status:'success',per_page:'100'});
  if (kind === 'ci') params.set('head_sha',candidate);
  const result = read(`repos/${FORK}/actions/workflows/${wf.id}/runs?${params}`);
  must(Number.isSafeInteger(result.total_count) && result.total_count <= 100 && result.workflow_runs.length === result.total_count,'incomplete fork evidence pagination');
  const {validateJobs,assertPolicy} = require('./release-evidence.cjs');
  const required = requiredJobs(kind,candidate,disableMacos);
  for (const run of result.workflow_runs) {
    if (run.repository?.id !== ID || run.head_repository?.id !== ID || run.workflow_id !== wf.id || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success') continue;
    if (kind === 'ci' && (run.head_sha !== candidate || run.head_branch !== branch || run.display_title !== `ocx-ci-v1 lane=all sha=${candidate}`)) continue;
    if (kind === 'service' && run.head_branch !== 'dev') continue;
    if (!releaseUser(run.actor) || !releaseUser(run.triggering_actor)) continue;
    try { await assertPolicy(async path => read(`repos/${FORK}${path}`),run,kind,policies); }
    catch (error) {
      // An unapproved run is not evidence; transport/incomplete/unknown failures are fatal.
      if (error instanceof Error && error.message === `unapproved ${kind} workflow or helper policy`) continue;
      throw error;
    }
    const jobs = read(`repos/${FORK}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    must(jobs.total_count <= 100 && jobs.jobs.length === jobs.total_count,'incomplete fork jobs');
    try { validateJobs(jobs.jobs,required); }
    catch { continue; }
    source(branch,candidate,read,authority);
    return {sourceSha:candidate,ciRunId:run.id};
  }
  throw Error(`no qualifying fork ${kind} evidence`);
}
async function history(branch,candidate,version) {
  const base = source(branch,candidate);
  const npm = await registry();
  const release = api(`repos/lidge-jun/opencodex/releases/tags/v${base}`);
  validateAge(release,npm,base);
  validateVersion(base,version);
  // Git checkout must contain full candidate ancestry; missing objects fail closed.
  const upstreamTag = api(`repos/lidge-jun/opencodex/commits/v${base}`).sha;
  must(SHA.test(upstreamTag),'invalid upstream base SHA');
  git('merge-base','--is-ancestor',upstreamTag,candidate);
  const metadata = JSON.parse(git('show',`${candidate}:package.json`));
  must(metadata.version === version && metadata.name === '@bitkyc08/opencodex','candidate package version or namespace mismatch');
  validateOrdering(version,git('tag','--merged',candidate,'--list','v*').split('\n').filter(Boolean));
  const exact = api(`repos/${FORK}/git/matching-refs/tags/v${version}`);
  must(!exact.some(ref => ref.ref === `refs/tags/v${version}`),'fork tag already exists');
  return {floor:null,channels:[],sourceSha:candidate,baseVersion:base,version};
}
async function main(args) {
  const [command,candidate,version] = args, branch = process.env.FORK_RELEASE_BRANCH;
  must(process.env.GITHUB_REPOSITORY === FORK,'fork guard only applies to alexalok/opencodex');
  if (command === 'source') return source(branch,candidate);
  if (command === 'history') return history(branch,candidate,version);
  if (['resolve','check','service'].includes(command)) return evidence(branch,candidate,command === 'service' ? 'service':'ci');
  throw Error('unknown fork release operation');
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result)+'\n')).catch(error => { console.error(`fork release: ${error.message}`); process.exitCode=1; });
module.exports = {requiredJobs,assertReleaseAuthority,validateOrdering,validateSelection,validateAge,validateVersion,source,evidence,history};
