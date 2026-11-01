// Layout and dependency rule (D1): scans the import specifiers of every .ts file in the feature folders.
//  - fast-feed/ never imports pga/, pga/ never imports fast-feed/
//  - combo/ is the only feature folder that imports both (sim is the stack, not a feature)
//  - sim/ may import pga/rules, fast-feed/mock, fast-feed/client/abi.ts and shared/
//  - nothing imports combo/ (except combo's own files)
//  - shared/ imports no feature folder
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FOLDERS = ['shared', 'sim', 'fast-feed', 'pga', 'combo'] as const
type Folder = (typeof FOLDERS)[number]

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return tsFiles(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

/** Relative import specifiers (static `from '...'`, `import('...')`, side-effect `import '...'`) of one file. */
export function specifiers(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)) out.push(m[1]!)
  return out
}

function folderOf(path: string): Folder | undefined {
  const top = relative(root, path).split(sep)[0]
  return (FOLDERS as readonly string[]).includes(top!) ? (top as Folder) : undefined
}

interface Edge {
  file: string
  from: Folder
  to: Folder
  target: string
}

const edges: Edge[] = []
for (const folder of FOLDERS) {
  for (const file of tsFiles(join(root, folder))) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      const to = folderOf(target)
      assert.ok(to, `${relative(root, file)} imports ${spec}, which is outside every known folder`)
      edges.push({ file: relative(root, file), from: folder, to, target: relative(root, target) })
    }
  }
}

// the one shared test that reaches into a feature folder (it checks the sim banner against shared/config)
const SHARED_TEST_EXEMPT = new Set([join('shared', 'test', 'config.test.ts')])
const isTest = (e: Edge) => SHARED_TEST_EXEMPT.has(e.file)
const describe = (es: Edge[]) => es.map((e) => `${e.file} -> ${e.target}`).join('\n')

test('the scan finds the imports it is meant to police', () => {
  assert.ok(edges.length > 50)
  assert.ok(edges.some((e) => e.from === 'combo' && e.to === 'pga'))
  assert.ok(edges.some((e) => e.from === 'combo' && e.to === 'fast-feed'))
  assert.deepEqual(specifiers(`import { a } from '../x.ts'\nconst b = await import('../y.ts')\nimport './z.ts'`), ['../x.ts', '../y.ts', './z.ts'])
})

test('fast-feed never imports pga, pga never imports fast-feed, so only combo can import both', () => {
  const bad = edges.filter((e) => (e.from === 'fast-feed' && e.to === 'pga') || (e.from === 'pga' && e.to === 'fast-feed'))
  assert.deepEqual(bad, [], describe(bad))
  const both = FOLDERS.filter(
    (f) => f !== 'combo' && f !== 'sim' && edges.some((e) => e.from === f && e.to === 'fast-feed') && edges.some((e) => e.from === f && e.to === 'pga'),
  )
  assert.deepEqual(both, [], `only combo (and sim, the stack) may import both features, also found: ${both.join(', ')}`)
})

test('nothing imports combo except combo itself', () => {
  const bad = edges.filter((e) => e.to === 'combo' && e.from !== 'combo')
  assert.deepEqual(bad, [], describe(bad))
})

test('shared imports no feature folder', () => {
  const bad = edges.filter((e) => e.from === 'shared' && e.to !== 'shared' && !isTest(e))
  assert.deepEqual(bad, [], describe(bad))
})

test('sim imports only pga/rules, fast-feed/mock, fast-feed/client/abi.ts and shared', () => {
  const allowed = (e: Edge) =>
    e.to === 'sim' ||
    e.to === 'shared' ||
    e.target.startsWith(join('pga', 'rules') + sep) ||
    e.target.startsWith(join('fast-feed', 'mock') + sep) ||
    e.target.replace(/\.ts$/, '') === join('fast-feed', 'client', 'abi')
  const bad = edges.filter((e) => e.from === 'sim' && !isTest(e) && !allowed(e))
  assert.deepEqual(bad, [], describe(bad))
})

test('every feature folder has a README', () => {
  for (const f of ['sim', 'fast-feed', 'pga', 'combo']) assert.ok(statSync(join(root, f, 'README.md')).isFile(), `${f}/README.md`)
})

test('no stray backup files (-E, .bak, .orig, .rej, ~) under the source folders', () => {
  const all = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      if (n === 'node_modules' || n === 'out' || n === 'cache') return []
      const p = join(dir, n)
      return statSync(p).isDirectory() ? all(p) : [p]
    })
  const stray = ['shared', 'sim', 'fast-feed', 'pga', 'combo', 'contracts', 'docs']
    .flatMap((f) => all(join(root, f)))
    .filter((p) => /(-E|\.bak|\.orig|\.rej|~)$/.test(p))
  assert.deepEqual(stray, [])
})
