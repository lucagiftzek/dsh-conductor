#!/usr/bin/env node
/**
 * Switch a DSH profile from dsh-force-compact, dsh-orchestrator and dsh-continue to
 * dsh-conductor. Dry run by default: prints what would change. Nothing is
 * restarted; restart dsh-web yourself afterwards.
 *
 *   node scripts/migrate-profile.mjs [--profile ~/.dsh/profiles/web] [--apply]
 *                                    [--link /path/to/dsh-conductor] [--no-legacy-tools]
 *
 * What --apply does (backups first, <file>.bak-conductor-<timestamp>):
 *   package.json      add "dsh-conductor" (link: to this checkout unless --link),
 *                     add it to dsh.profile.bundles, remove dsh-force-compact and
 *                     dsh-orchestrator from dependencies and bundles
 *   cordis.patch.yml  copy the dsh-orchestrator row's config into a new
 *                     dsh-conductor row (runners, providers, trusted hosts, limits),
 *                     keep shell tasks and remote runners ON when the old row used
 *                     runners, keep the old orch_* tool names (tools.legacy),
 *                     carry a force-compact row's config into conductor.compact,
 *                     then remove the old rows
 * Then run `pnpm install` in the profile and restart dsh-web.
 * Roll back: copy the two .bak-conductor-* files back, pnpm install, restart.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
const profileDir = resolve(expand(option('--profile', join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web'))))
const apply = flag('--apply')
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWN = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const PKG = OWN.name // dsh-conductor (checkout) or @lucagiftzek/dsh-conductor (npm)
const installed = here.split(/[\\/]/).includes('node_modules')
const linkTarget = option('--link', installed ? null : here)
const legacyTools = !flag('--no-legacy-tools')

async function loadYaml() {
  const bases = [import.meta.url, join(profileDir, 'probe.js')]
  try {
    // the dsh install that sits next to this node binary (nvm or system layout)
    const node = realpathSync(process.execPath)
    bases.push(join(dirname(node), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } catch { /* optional */ }
  for (const base of bases) {
    try {
      const path = createRequire(base).resolve('yaml')
      return await import(pathToFileURL(path).href)
    } catch { /* next */ }
  }
  throw new Error('the "yaml" package was not found (it ships with the dsh install); run this with the same node that runs dsh')
}

const pkgPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(pkgPath) || !existsSync(patchPath)) {
  console.error(`not a DSH profile: ${profileDir} (package.json and cordis.patch.yml are required)`)
  process.exit(2)
}

const YAML = await loadYaml()
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const doc = YAML.parseDocument(readFileSync(patchPath, 'utf8'), { logLevel: 'error' })
if (!YAML.isSeq(doc.contents)) {
  console.error('cordis.patch.yml is not a YAML list')
  process.exit(2)
}

const changes = []
// all of these are inside dsh-conductor (unscoped names are local checkouts)
const OLD = ['dsh-force-compact', 'dsh-orchestrator', '@lucagiftzek/dsh-orchestrator', '@weibaohui/dsh-continue', 'dsh-continue']

// ── package.json ──
pkg.dependencies ??= {}
const bundles = pkg.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('package.json has no dsh.profile.bundles list')
  process.exit(2)
}
for (const name of OLD) {
  if (name in pkg.dependencies) { delete pkg.dependencies[name]; changes.push(`package.json: remove dependency ${name}`) }
  const at = bundles.indexOf(name)
  if (at >= 0) { bundles.splice(at, 1); changes.push(`package.json: remove bundle ${name}`) }
}
// Installed from npm or GitHub: keep the existing dependency. From a checkout or --link: link to it.
const spec = linkTarget === null
  ? (pkg.dependencies[PKG] ?? `^${OWN.version}`)
  : linkTarget.startsWith('link:') || (/^[\w@^~]/.test(linkTarget) && !linkTarget.startsWith('/')) ? linkTarget : `link:${linkTarget}`
if (pkg.dependencies[PKG] !== spec) { pkg.dependencies[PKG] = spec; changes.push(`package.json: dependency ${PKG} = ${spec}`) }
if (!bundles.includes(PKG)) {
  const after = bundles.indexOf('dsh-better-sidebar')
  bundles.splice(after >= 0 ? after + 1 : bundles.length, 0, PKG)
  changes.push(`package.json: add bundle ${PKG}`)
}

// ── cordis.patch.yml ──
const items = doc.contents.items
const idOf = (node) => (YAML.isMap(node) ? node.get('id') : undefined)
const rows = (id) => items.filter((node) => idOf(node) === id)
const insertedId = (node) => {
  if (!YAML.isMap(node) || !node.has('insert')) return []
  const list = node.get('insert')
  return YAML.isSeq(list) ? list.items.map(idOf).filter(Boolean) : []
}

const orchestratorConfig = {}
for (const row of rows('dsh-orchestrator')) Object.assign(orchestratorConfig, row.get('config')?.toJSON?.() ?? {})
const compactConfig = {}
for (const row of rows('force-compact')) Object.assign(compactConfig, row.get('config')?.toJSON?.() ?? {})
const continueConfig = {}
for (const row of rows('dsh-continue')) Object.assign(continueConfig, row.get('config')?.toJSON?.() ?? {})
const REMOVE = new Set(['dsh-orchestrator', 'force-compact', 'dsh-continue'])

const source = readFileSync(patchPath, 'utf8')
let appended = ''
if (rows('dsh-conductor').length === 0) {
  const config = { ...orchestratorConfig }
  delete config.stateDir
  if (config.api) delete config.api.secret // secrets stay in the environment or the settings store
  const usesRunners = Array.isArray(config.runners) && config.runners.some((r) => r && r.kind && r.kind !== 'local')
  config.tasks = { ...(config.tasks ?? {}), allowCommandTasks: true, ...(usesRunners ? { allowRemoteRunners: true } : {}) }
  config.tools = { chat: true, chats: true, tasks: true, legacy: legacyTools }
  config.legacyRoute = true // scripts still calling /dsh-orchestrator/api keep working
  config.setupCompleted = `${new Date().toISOString()} (migration)` // configured here: no setup guide in the sidebar
  if (Object.keys(compactConfig).length) config.compact = compactConfig
  // dsh-continue's resume text becomes Recovery's (it replaces the closing instruction of every resume)
  if (typeof continueConfig.prompt === 'string' && continueConfig.prompt.trim()) config.recovery = { resumeText: continueConfig.prompt.trim().slice(0, 2000) }
  if (continueConfig.enabled === false) config.recovery = { ...(config.recovery ?? {}), enabled: false }
  appended = `# ${new Date().toISOString().slice(0, 10)}: dsh-conductor replaces dsh-orchestrator, dsh-force-compact and dsh-continue (scripts/migrate-profile.mjs); config carried over from their rows\n${YAML.stringify([{ id: 'dsh-conductor', config }], { lineWidth: 0 })}`
  changes.push(`cordis.patch.yml: add row dsh-conductor (from the dsh-orchestrator row: ${Object.keys(orchestratorConfig).join(', ') || 'no config'}; tasks.allowCommandTasks=true${usesRunners ? ', allowRemoteRunners=true' : ''}; tools.legacy=${legacyTools}; legacyRoute=true; setupCompleted${config.recovery ? '; recovery from the dsh-continue row' : ''})`)
} else {
  changes.push('cordis.patch.yml: a dsh-conductor row already exists, left as it is')
}
// Remove the old rows by their exact source ranges, so every other line keeps its formatting.
const cuts = []
for (const node of items) {
  const id = idOf(node)
  const inserted = insertedId(node)
  if (REMOVE.has(id) || inserted.some((x) => REMOVE.has(x))) {
    const start = source.lastIndexOf('\n', node.range[0]) + 1
    let end = source.indexOf('\n', Math.max(node.range[2] - 1, node.range[0]))
    end = end < 0 ? source.length : end + 1
    cuts.push([start, end])
    changes.push(`cordis.patch.yml: remove the ${id ?? `insert list (${inserted.join(', ')})`} row`)
  }
}
let edited = source
for (const [start, end] of cuts.sort((x, y) => y[0] - x[0])) edited = edited.slice(0, start) + edited.slice(end)
if (appended) edited = `${edited.replace(/\n*$/, '\n')}${appended}`

console.log(`profile: ${profileDir}`)
for (const line of changes) console.log(`  ${line}`)
if (!apply) {
  console.log('\nDry run: nothing written. Re-run with --apply, then `pnpm install` in the profile and restart dsh-web.')
  process.exit(0)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(pkgPath, `${pkgPath}.bak-conductor-${stamp}`)
copyFileSync(patchPath, `${patchPath}.bak-conductor-${stamp}`)
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
writeFileSync(patchPath, edited)
console.log(`\nWritten. Backups: *.bak-conductor-${stamp}`)
console.log(`Next: cd ${profileDir} && pnpm install, then restart dsh-web.`)
