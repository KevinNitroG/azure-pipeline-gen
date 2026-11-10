#!/usr/bin/env node
'use strict';
/**
 * Fails when monorepo.graph.json drifts from reality:
 *  - project path missing
 *  - package.json name != packageName
 *  - package.json depends on a workspace package the graph does not list (incl. its transitive deps)
 *  - a .csproj ProjectReference points into another project that the graph does not list
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadGraph, transitiveDeps } = require('./lib/graph');

const graph = loadGraph(process.env.GRAPH_PATH || '.azure-pipelines/config/monorepo.graph.json');
const projects = graph.projects;
const errors = [];
const warnings = [];

const byPackage = new Map(Object.values(projects).filter((p) => p.packageName).map((p) => [p.packageName, p]));
const owner = (relPath) =>
  Object.values(projects)
    .filter((p) => relPath === p.path || relPath.startsWith(`${p.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];

const allowed = (p) => new Set([p.name, ...p.dependsOn]);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'bin', 'obj', '.git', 'dist'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.csproj')) acc.push(full);
  }
  return acc;
}

for (const p of Object.values(projects)) {
  if (!fs.existsSync(p.path)) {
    errors.push(`[${p.name}] path "${p.path}" does not exist`);
    continue;
  }

  if (p.kind === 'node') {
    const pkgFile = path.join(p.path, 'package.json');
    if (!fs.existsSync(pkgFile)) { errors.push(`[${p.name}] missing ${pkgFile}`); continue; }
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    if (p.packageName && pkg.name !== p.packageName) {
      errors.push(`[${p.name}] package.json name "${pkg.name}" != graph packageName "${p.packageName}"`);
    }
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })
      .filter((d) => byPackage.has(d))
      .map((d) => byPackage.get(d).name);
    const ok = allowed(p);
    for (const d of declared) {
      for (const need of [d, ...transitiveDeps(projects, d)]) {
        if (!ok.has(need)) errors.push(`[${p.name}] uses "${d}" which requires "${need}", but graph.dependsOn does not list it`);
      }
    }
    for (const d of p.dependsOn.filter((x) => projects[x].kind === 'node')) {
      const implied = declared.some((x) => x === d || transitiveDeps(projects, x).has(d));
      if (!implied) warnings.push(`[${p.name}] graph lists "${d}" but package.json never reaches it`);
    }
  }

  if (p.kind === 'dotnet') {
    const ok = allowed(p);
    for (const csproj of walk(p.path)) {
      const xml = fs.readFileSync(csproj, 'utf8');
      for (const m of xml.matchAll(/ProjectReference\s+Include="([^"]+)"/g)) {
        const target = path
          .relative(process.cwd(), path.resolve(path.dirname(csproj), m[1].replace(/\\/g, '/')))
          .split(path.sep)
          .join('/');
        const o = owner(target);
        if (o && !ok.has(o.name)) errors.push(`[${p.name}] ${csproj} references project "${o.name}" which is not in graph.dependsOn`);
      }
    }
  }
}

warnings.forEach((w) => console.log(`##vso[task.logissue type=warning]${w}`));
if (errors.length) {
  errors.forEach((e) => console.log(`##vso[task.logissue type=error]${e}`));
  process.exit(1);
}
console.log(`Graph OK: ${Object.keys(projects).length} projects, ${warnings.length} warning(s).`);
