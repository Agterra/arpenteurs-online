import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const LOG_PATH = join(process.cwd(), '.cache', 'import.log')

// Single-node by design premise; dev HMR reload of this module while a child
// runs would lose the flag — acceptable for an ops convenience button.
let running = false

export function isReimportRunning(): boolean {
  return running
}

/** Spawns the card import detached, logging to .cache/import.log. False if one is already running. */
export function startReimport(): boolean {
  if (running) return false
  mkdirSync(dirname(LOG_PATH), { recursive: true })
  const fd = openSync(LOG_PATH, 'w')
  const child = spawn(
    process.execPath,
    ['--env-file=.env', '--max-old-space-size=4096', 'scripts/import-cards.ts'],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', fd, fd] },
  )
  closeSync(fd)
  running = true
  child.on('exit', () => {
    running = false
  })
  child.on('error', () => {
    running = false
  })
  child.unref()
  return true
}

export function reimportLogTail(lines = 50): string | null {
  if (!existsSync(LOG_PATH)) return null
  const content = readFileSync(LOG_PATH, 'utf8').replace(/\n$/, '')
  return content.split('\n').slice(-lines).join('\n')
}
