/**
 * Test helpers.
 *
 * Each test gets its OWN in-memory database, so tests never share state and can run in
 * any order. In-memory keeps them fast (~ms) — which is the point of testing the service
 * layer here instead of driving a real ACP session each time.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../sqlite/schema.js'
import { ProjectService, type Clock } from '../service/project-service.js'

// Temp directories are registered globally and removed on process exit.
//
// Tests must NOT rely on calling their own cleanup: a failing `assert` throws past it and
// the directory leaks. That is exactly what happened — a test run left nine `wb-m3-*`
// directories behind, and they only appeared when a test actually failed. Registering here
// means cleanup survives a failed assertion, which is when it matters most.
const tempDirs: string[] = []
let exitHookInstalled = false

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const d of tempDirs) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {
          // Best effort: a leaked temp dir must never fail a test run.
        }
      }
    })
  }
  return dir
}

export interface Harness {
  readonly db: DatabaseSync
  readonly projects: ProjectService
  /** Advance the clock by one second; timestamps stay deterministic and ordered. */
  tick(): void
  close(): void
}

/** A clock a test can move at will, so ordering assertions never depend on wall time. */
export function fakeClock(start = '2026-01-01T00:00:00.000Z'): Clock & { tick(): void } {
  let current = Date.parse(start)
  return {
    now: () => new Date(current).toISOString(),
    tick: () => {
      current += 1000
    },
  }
}

export function harness(): Harness {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const clock = fakeClock()
  const projects = new ProjectService(db, clock)

  return {
    db,
    projects,
    tick: () => clock.tick(),
    close: () => db.close(),
  }
}

/** Count rows in a table — used to assert that a rejected write left nothing behind. */
export function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return Number(row.c)
}
