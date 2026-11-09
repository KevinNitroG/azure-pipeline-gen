#!/usr/bin/env node
'use strict';
/**
 * Computes, from git history + monorepo.graph.json:
 *   affected_<key>  project changed OR depends (transitively) on something changed  -> test / lint / deploy
 *   needed_<key>    affected OR a (transitive) dependency of an affected project    -> must be built
 * and emits dynamic matrices for downstream stages.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadGraph, closureUp, closureDown, transitiveDeps, matchesAny } = require('./lib/graph');

const env = process.env;

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
const out = (name, value) => console.log(`##vso[task.setvariable variable=${name};isOutput=true]${value}`);

async function lastSuccessfulCommit() {
  const { SYSTEM_COLLECTIONURI, SYSTEM_TEAMPROJECT, SYSTEM_DEFINITIONID, BUILD_SOURCEBRANCH, SYSTEM_ACCESSTOKEN } = env;
  if (!SYSTEM_ACCESSTOKEN || !SYSTEM_COLLECTIONURI) return null;
  const url =
    `${SYSTEM_COLLECTIONURI}${encodeURIComponent(SYSTEM_TEAMPROJECT)}/_apis/build/builds` +
    `?definitions=${SYSTEM_DEFINITIONID}&branchName=${encodeURIComponent(BUILD_SOURCEBRANCH)}` +
    `&statusFilter=completed&resultFilter=succeeded&queryOrder=finishTimeDescending&$top=1&api-version=7.1`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${SYSTEM_ACCESSTOKEN}` } });
    if (!res.ok) {
      console.log(`##[warning]Builds API returned HTTP ${res.status}; falling back to HEAD~1`);
      return null;
    }
    const body = await res.json();
    return body.value?.[0]?.sourceVersion ?? null;
  } catch (e) {
    console.log(`##[warning]Builds API call failed (${e.message}); falling back to HEAD~1`);
    return null;
  }
}

async function resolveBase() {
  if (String(env.FORCE_ALL).toLowerCase() === 'true') return { all: 'forceAll parameter set' };
  if (env.BUILD_REASON === 'Schedule') return { all: 'scheduled run' };
  if ((env.BUILD_SOURCEBRANCH || '').startsWith('refs/tags/')) return { all: 'tag build' };

  if (env.BUILD_REASON === 'PullRequest') {
    const target = (env.SYSTEM_PULLREQUEST_TARGETBRANCH || 'refs/heads/main').replace(/^refs\/heads\//, '');
    const base = git(['merge-base', 'HEAD', `origin/${target}`]);
    return base
      ? { base, why: `merge-base with origin/${target}` }
      : { all: `could not resolve origin/${target}` };
  }

  const head = git(['rev-parse', 'HEAD']);
  const last = await lastSuccessfulCommit();
  if (last && last !== head && git(['cat-file', '-e', `${last}^{commit}`]) !== null) {
    return { base: last, why: 'last successful build on this branch' };
  }
  const parent = git(['rev-parse', '--verify', 'HEAD~1']);
  if (parent) return { base: parent, why: 'previous commit (no usable build history)' };
  return { all: 'no base commit could be resolved' };
}

(async () => {
  const graph = loadGraph(env.GRAPH_PATH || '.azure-pipelines/config/monorepo.graph.json');
  const projects = graph.projects;
  const names = Object.keys(projects);

  const resolution = await resolveBase();
  const seed = new Set();
  const unowned = [];
  let files = [];

  if (resolution.all) {
    names.forEach((n) => seed.add(n));
  } else {
    files = (git(['diff', '--name-only', '--no-renames', resolution.base, 'HEAD']) || '').split('\n').filter(Boolean);
    for (const f of files) {
      if (matchesAny(f, graph.ignore)) continue;
      let owned = false;
      for (const p of Object.values(projects)) {
        if (f === p.path || f.startsWith(`${p.path}/`)) { seed.add(p.name); owned = true; }
      }
      for (const rule of graph.rules || []) {
        if (!matchesAny(f, rule.match)) continue;
        owned = true;
        const targets = rule.affects.includes('*') ? names : rule.affects;
        for (const t of targets) {
          if (!projects[t]) throw new Error(`Rule references unknown project "${t}"`);
          seed.add(t);
        }
      }
      if (!owned) unowned.push(f);
    }
  }

  const affected = closureUp(projects, seed);
  const needed = closureDown(projects, affected);

  const root = graph.codegenRoot;
  const needsCodegen = [...needed].some((n) => n === root || transitiveDeps(projects, n).has(root));
  const deployAny = [...affected].some((n) => projects[n].deployable);
  const releaseAny = [...affected].some((n) => projects[n].deployable || projects[n].publish);

  // ---- matrices (leg names must be [A-Za-z0-9_]) ---------------------------
  const legs = (set, pred, build) =>
    Object.fromEntries([...set].filter((n) => pred(projects[n])).map((n) => [projects[n].key, build(projects[n])]));

  const matrixNode = legs(affected, (p) => p.kind === 'node', (p) => ({ projectName: p.name, projectPath: p.path }));
  const matrixDotnet = legs(affected, (p) => p.kind === 'dotnet', (p) => ({ projectName: p.name, projectPath: p.path, projectSolution: p.solution }));
  const matrixGo = legs(affected, (p) => p.kind === 'go', (p) => ({ projectName: p.name, projectPath: p.path }));
  const matrixImage = legs(needed, (p) => !!p.image, (p) => ({
    imageName: p.name,
    imageRepo: p.image.repository,
    imageDockerfile: p.image.dockerfile,
    imageContext: p.image.context,
  }));

  // ---- outputs -------------------------------------------------------------
  for (const p of Object.values(projects)) {
    out(`affected_${p.key}`, affected.has(p.name));
    out(`needed_${p.key}`, needed.has(p.name));
  }
  out('affected_any', affected.size > 0);
  out('needsCodegen', needsCodegen);
  out('deploy_any', deployAny);
  out('release_any', releaseAny);
  out('needs_images', Object.keys(matrixImage).length > 0);
  out('matrix_node', JSON.stringify(matrixNode));
  out('matrix_dotnet', JSON.stringify(matrixDotnet));
  out('matrix_go', JSON.stringify(matrixGo));
  out('matrix_image', JSON.stringify(matrixImage));
  out('affected_list', [...affected].join(','));

  // ---- human-readable report ----------------------------------------------
  const rows = names.map((n) => `| ${n} | ${projects[n].kind} | ${affected.has(n) ? 'yes' : '-'} | ${needed.has(n) ? 'yes' : '-'} |`);
  const summary = [
    '# Change detection',
    '',
    `**Mode:** ${resolution.all ? `ALL (${resolution.all})` : `diff against ${resolution.base.slice(0, 10)} (${resolution.why})`}`,
    `**Changed files:** ${files.length}  |  **Codegen needed:** ${needsCodegen}  |  **Deploy needed:** ${deployAny}`,
    '',
    '| project | kind | affected (test/deploy) | needed (build) |',
    '|---|---|---|---|',
    ...rows,
    ...(unowned.length ? ['', `Unowned files (ignored): ${unowned.slice(0, 20).join(', ')}${unowned.length > 20 ? ', ...' : ''}`] : []),
  ].join('\n');

  const dir = path.join(env.BUILD_ARTIFACTSTAGINGDIRECTORY || '.', 'plan');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.md'), summary);
  fs.writeFileSync(
    path.join(dir, 'affected.json'),
    JSON.stringify({ resolution, affected: [...affected], needed: [...needed], files }, null, 2),
  );
  console.log(summary);
  console.log(`##vso[task.uploadsummary]${path.join(dir, 'summary.md')}`);
})().catch((e) => {
  console.error(`##vso[task.logissue type=error]${e.message}`);
  process.exit(1);
});
