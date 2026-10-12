/**
 * Database connection lifecycle.
 *
 * WAL is used so a long read never blocks a write. Foreign keys are ON because the
 * schema relies on cascades being real, not decorative.
 */
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './schema.js'

export interface OpenOptions {
  /** Path to the database file, or ':memory:' for tests. */
  readonly path: string
}

export function openDatabase(options: OpenOptions): DatabaseSync {
  const path = options.path === ':memory:' ? ':memory:' : resolve(options.path)

  if (path !== ':memory:') {
    if (!isAbsolute(path)) throw new Error(`database path must resolve to an absolute path: ${path}`)
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  // Give a concurrent writer a chance instead of failing instantly.
  db.exec('PRAGMA busy_timeout = 5000')

  migrate(db)
  return db
}
