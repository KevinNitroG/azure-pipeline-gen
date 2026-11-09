'use strict';
// Shared graph helpers for detect-changes.js and validate-graph.js

const fs = require('node:fs');

const keyOf = (name) => name.replace(/[^A-Za-z0-9]/g, '_');

function loadGraph(file) {
  const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, p] of Object.entries(graph.projects)) {
    p.name = name;
    p.key = keyOf(name);
    p.dependsOn = p.dependsOn || [];
    for (const d of p.dependsOn) {
      if (!graph.projects[d]) throw new Error(`Project "${name}" depends on unknown project "${d}"`);
    }
  }
  assertAcyclic(graph.projects);
  return graph;
}

function assertAcyclic(projects) {
  const state = {};
  const visit = (n, stack) => {
    if (state[n] === 2) return;
    if (state[n] === 1) throw new Error(`Dependency cycle: ${[...stack, n].join(' -> ')}`);
    state[n] = 1;
    for (const d of projects[n].dependsOn) visit(d, [...stack, n]);
    state[n] = 2;
  };
  Object.keys(projects).forEach((n) => visit(n, []));
}

function dependentsOf(projects) {
  const map = Object.fromEntries(Object.keys(projects).map((n) => [n, []]));
  for (const p of Object.values(projects)) for (const d of p.dependsOn) map[d].push(p.name);
  return map;
}

/** seed + everything that (transitively) depends on seed */
function closureUp(projects, seed) {
  const rev = dependentsOf(projects);
  const out = new Set(seed);
  const stack = [...seed];
  while (stack.length) {
    for (const d of rev[stack.pop()]) if (!out.has(d)) { out.add(d); stack.push(d); }
  }
  return out;
}

/** seed + everything seed (transitively) depends on */
function closureDown(projects, seed) {
  const out = new Set(seed);
  const stack = [...seed];
  while (stack.length) {
    for (const d of projects[stack.pop()].dependsOn) if (!out.has(d)) { out.add(d); stack.push(d); }
  }
  return out;
}

function transitiveDeps(projects, name) {
  const s = closureDown(projects, [name]);
  s.delete(name);
  return s;
}

const cache = new Map();
function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${re}$`);
  cache.set(glob, rx);
  return rx;
}

const matchesAny = (file, globs) => (globs || []).some((g) => globToRegExp(g).test(file));

module.exports = { keyOf, loadGraph, closureUp, closureDown, transitiveDeps, matchesAny };
