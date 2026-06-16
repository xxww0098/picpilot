#!/usr/bin/env node
// One-off refactor helper (components, pass 2): fix ALL broken relative imports
// across src/ after grouping components into ui/modals/workspaces.
//
// Three resolution strategies, in order:
//  1. If the spec already resolves to a real file -> leave it.
//  2. Else look up the target basename in a components index (handles cross-
//     group refs like ../ModalShell -> ../ui/ModalShell) -> recompute.
//  3. Else if prepending "../" makes it resolve (handles external refs that
//     are now one level too shallow, e.g. ../store -> ../../store from a
//     file that moved deeper) -> apply.
//
// Scans ALL .ts/.tsx under src/ so App.tsx, store/*, hooks/* get fixed too.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, basename, join, sep, relative } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = '/root/picpilot'
const SRC = join(ROOT, 'src')
const COMPONENTS = join(SRC, 'components')

// components index by basename -> absolute path (for cross-group resolution)
const index = new Map()
const compFiles = execSync(`find ${COMPONENTS} -type f \\( -name '*.ts' -o -name '*.tsx' \\)`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
for (const f of compFiles) {
  index.set(basename(f).replace(/\.(ts|tsx)$/, ''), f)
}

const SPEC_RE = /(from\s+|import\s*\(\s*|export\s+(?:\*|\{[^}]*\})\s+from\s+|vi\.mock\(\s*)(['"])([^'"]+)\2/g

function resolveExists(absNoExt) {
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.css', '']) {
    const p = ext === '' ? absNoExt : absNoExt + ext
    if (existsSync(p)) { try { if (statSync(p).isFile()) return true } catch {} }
  }
  if (existsSync(absNoExt + '/index.ts')) return true
  return false
}

function fixSpec(importerAbsDir, spec) {
  if (!spec.startsWith('.')) return spec
  if (resolveExists(join(importerAbsDir, spec))) return spec

  // Strategy 2: components cross-group lookup by basename.
  const last = spec.split(sep).pop().replace(/\.(ts|tsx)$/, '')
  const found = index.get(last)
  if (found) {
    let rel = relative(importerAbsDir, found.replace(/\.(ts|tsx)$/, '')).split(sep).join('/')
    if (!rel.startsWith('.')) rel = './' + rel
    if (resolveExists(join(importerAbsDir, rel))) return rel
  }

  // Strategy 3: prepend ../ for external refs now one level too shallow.
  const deeper = spec.startsWith('./') ? '../' + spec.slice(2) : '../' + spec
  if (resolveExists(join(importerAbsDir, deeper))) return deeper

  return spec
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

const allSrc = execSync(`find ${SRC} -type f \\( -name '*.ts' -o -name '*.tsx' \\)`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
let touched = 0
const touchedFiles = []
for (const f of allSrc) {
  try { if (rewriteFile(f)) { touched++; touchedFiles.push(f.replace(SRC + '/', '')) } }
  catch (e) { console.error('ERR', f, e.message) }
}
console.log(`Pass 2 rewrote imports in ${touched} files:`)
console.log(touchedFiles.sort().join('\n'))
