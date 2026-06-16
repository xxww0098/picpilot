#!/usr/bin/env node
// One-off refactor helper (pass 2): fix remaining relative imports that point
// OUTSIDE the remapped module table — i.e. to ../types, ../store, ../hooks,
// ../components, or across lib subdirs (./platforms/*, ./openaiCompatible/*,
// ./workflow/*). These broke because source files moved one level deeper
// into src/lib/<subdir>/.
//
// Strategy: for each relative import that currently does NOT resolve to a
// real file, try inserting one more "../" and check again. Also handle the
// cross-subdir case (./X -> ../X when X is a sibling of the new subdir).
//
// We determine "real file" by stat-ing candidate paths with .ts/.tsx/.js exts.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = '/root/picpilot'

const SPEC_RE = /(from\s+|import\s*\(\s*|export\s+(?:\*|\{[^}]*\})\s+from\s+)(['"])([^'"]+)\2/g

function resolveExists(absNoExt) {
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.json', '']) {
    const p = ext === '' ? absNoExt : absNoExt + ext
    if (existsSync(p)) {
      try {
        const s = statSync(p)
        if (s.isFile()) return true
        // directory with index? unlikely here
      } catch {}
    }
    // also try as directory + index.ts
    if (existsSync(absNoExt + '/index.ts')) return true
  }
  return false
}

function fixSpec(importerDir, spec) {
  if (!spec.startsWith('.')) return spec
  const candidate = join(importerDir, spec)
  if (resolveExists(candidate)) return spec // already fine
  // Try one level deeper: prepend ../ to spec (i.e. resolve from parent)
  const deeper = '../' + spec.replace(/^\.\//, '')
  const candidate2 = join(importerDir, deeper)
  if (resolveExists(candidate2)) return deeper
  return spec // give up, leave for manual
}

function rewriteFile(path) {
  const src = readFileSync(path, 'utf8')
  const importerDir = dirname(path)
  let changed = false
  const out = src.replace(SPEC_RE, (m, prefix, q, spec) => {
    const fixed = fixSpec(importerDir, spec)
    if (fixed !== spec) { changed = true; return `${prefix}${q}${fixed}${q}` }
    return m
  })
  if (changed) writeFileSync(path, out)
  return changed
}

const files = execSync(`find ${ROOT}/src -type f \\( -name '*.ts' -o -name '*.tsx' \\)`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)

let touched = 0
for (const f of files) {
  try { if (rewriteFile(f)) touched++ } catch (e) { console.error('ERR', f, e.message) }
}
console.log(`Pass 2 rewrote imports in ${touched} files.`)
