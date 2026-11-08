/**
 * Resolve DSH core packages (@deepseek-ai/*) at run time without static
 * imports: a failed static import is a boot-killing SyntaxError, while a
 * failed dynamic import degrades to an honest warning.
 *
 * Order: bare specifier (works when the plugin sits under a profile's
 * node_modules), then createRequire from the profile and the running dsh
 * binary, then the dsh install's own node_modules derived from argv[1].
 */
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const cache = new Map()

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function installRoot() {
  try {
    const real = realpathSync(process.argv[1] || '')
    const at = real.indexOf(`${sep}lib${sep}bin.js`)
    return at > 0 ? real.slice(0, at) : undefined
  } catch {
    return undefined
  }
}

function requireBases() {
  const bases = [import.meta.url]
  if (process.env.DSH_PROFILE) bases.push(join(dshHome(), 'profiles', process.env.DSH_PROFILE, 'probe.js'))
  bases.push(join(dshHome(), 'profiles', 'web', 'probe.js'))
  const root = installRoot()
  if (root) bases.push(join(root, 'lib', 'bin.js'))
  if (process.argv[1]) bases.push(process.argv[1])
  return bases
}

/**
 * Import one core package by name; resolves to the module namespace or null.
 * @param {string} name e.g. '@deepseek-ai/dsh-llm'
 * @returns {Promise<{ mod: any, via: string } | { mod: null, reasons: string[] }>}
 */
export async function importCore(name) {
  if (cache.has(name)) return cache.get(name)
  const reasons = []
  const settle = (value) => {
    cache.set(name, value)
    return value
  }
  try {
    return settle({ mod: await import(name), via: 'import' })
  } catch (error) {
    reasons.push(`import: ${String(error?.message || error).slice(0, 160)}`)
  }
  for (const base of requireBases()) {
    try {
      const resolved = createRequire(base).resolve(name)
      return settle({ mod: await import(pathToFileURL(resolved).href), via: `resolve from ${base}` })
    } catch { /* next base */ }
  }
  const root = installRoot()
  if (root) {
    const dir = join(root, 'node_modules', ...name.split('/'))
    for (const file of ['lib/index.js', 'dist/index.js', 'index.js']) {
      const path = join(dir, file)
      if (!existsSync(path)) continue
      try {
        return settle({ mod: await import(pathToFileURL(path).href), via: `path ${path}` })
      } catch (error) {
        reasons.push(`path: ${String(error?.message || error).slice(0, 160)}`)
      }
    }
  }
  reasons.push('not found in the profile or the dsh install')
  return settle({ mod: null, reasons })
}

/** Test seam: forget resolved modules. */
export function resetCoreImports() {
  cache.clear()
}
