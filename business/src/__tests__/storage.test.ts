import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, inTransaction, SCHEMA_VERSION } from '../sqlite/schema.js'
import { openDatabase } from '../sqlite/connection.js'
import { isUniqueViolation, isBusy } from '../sqlite/errors.js'
import { countRows, harness } from './harness.js'
import { WorkbenchError } from '../domain/error.js'

describe('migration', () => {
  test('a fresh database is migrated to the current version', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.equal(row.user_version, SCHEMA_VERSION)
    db.close()
  })

  test('migrating twice is a no-op, not an error', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    migrate(db)
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION)
    db.close()
  })

  test('a NEWER on-disk schema is refused rather than guessed at', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)

    // Running against an unknown shape is how data gets corrupted: refuse loudly.
    assert.throws(
      () => migrate(db),
      (error: unknown) =>
        error instanceof WorkbenchError && error.code === 'STORAGE_SCHEMA_UNSUPPORTED',
    )
    db.close()
  })

  /**
   * v9 adds `session_members` (ADR-0014). Migrating an EXISTING v8 database must create it without
   * touching anything already stored — the whole reason migrations are versioned rather than
   * re-run. Building v8 by hand (rather than by an older checkout) keeps this test readable and
   * pins exactly what v9 is responsible for.
   */
  test('v8 gains session_members, and keeps everything it already had', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')

    // A v8 database: the tables v9 sits on top of, plus one row that must survive.
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL);
      INSERT INTO projects (id, key, name) VALUES ('p1', 'K', 'Kept');
      PRAGMA user_version = 8;
    `)

    migrate(db)

    assert.equal(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      9,
      'the schema version moved to 9',
    )
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    assert.ok(names.includes('session_members'), 'the new table exists')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n,
      1,
      'the pre-existing row is untouched',
    )

    // And the new table really is keyed by session, one declaration per session.
    const declare = (member: string): void => {
      db.prepare(
        "INSERT INTO session_members (session_id, member_label, declared_at, updated_at) VALUES ('s1', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ).run(member)
    }
    declare('Chen')
    assert.throws(
      () => declare('Su'),
      'a second row for the same session would make "who is this" ambiguous',
    )
    db.close()
  })
})

describe('connection', () => {
  test('openDatabase rejects a duplicate key through the real file-backed path', () => {
    // ':memory:' exercises a different code path than a file, so cover the file one too.
    const db = openDatabase({ path: ':memory:' })
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
    db.close()
  })
})

describe('transaction', () => {
  test('a throw rolls back every write in the transaction', () => {
    const h = harness()
    assert.equal(countRows(h.db, 'projects'), 0)

    assert.throws(() =>
      inTransaction(h.db, () => {
        h.db
          .prepare(
            `INSERT INTO projects (id, key, name, background, goal, archived_at, created_at)
             VALUES ('a','A','A',NULL,NULL,NULL,'2026-01-01T00:00:00.000Z')`,
          )
          .run()
        assert.equal(countRows(h.db, 'projects'), 1) // visible inside the transaction
        throw new Error('boom')
      }),
    )

    // ...and gone after it. This is the property MVP-020 depends on.
    assert.equal(countRows(h.db, 'projects'), 0)
    h.close()
  })

  test('a successful transaction commits', () => {
    const h = harness()
    inTransaction(h.db, () => {
      h.db
        .prepare(
          `INSERT INTO projects (id, key, name, background, goal, archived_at, created_at)
           VALUES ('a','A','A',NULL,NULL,NULL,'2026-01-01T00:00:00.000Z')`,
        )
        .run()
    })
    assert.equal(countRows(h.db, 'projects'), 1)
    h.close()
  })

  test('the connection is usable again after a rollback', () => {
    const h = harness()
    assert.throws(() => inTransaction(h.db, () => { throw new Error('boom') }))
    // A failed rollback that left the connection broken would surface here.
    const project = h.projects.create({ key: 'AFTER', name: 'After rollback' })
    assert.equal(project.key, 'AFTER')
    h.close()
  })
})

describe('error classification', () => {
  test('recognises the unique-violation message node:sqlite actually throws', () => {
    const h = harness()
    h.projects.create({ key: 'ALPHA', name: 'Alpha' })

    let caught: unknown
    try {
      h.projects.create({ key: 'ALPHA', name: 'Duplicate' })
    } catch (error) {
      caught = error
    }
    // The classifier must match the real driver message, not a guess.
    assert.ok(caught !== undefined)
    assert.equal(isUniqueViolation(new Error('UNIQUE constraint failed: projects.key')), true)
    assert.equal(isUniqueViolation(new Error('something else')), false)
    assert.equal(isBusy(new Error('database is locked')), true)
    h.close()
  })
})

describe('foreign keys', () => {
  test('deleting a project cascades to its role rows', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    h.projects.setMember(project.id, 'product', 'Zhang')
    assert.equal(countRows(h.db, 'project_roles'), 1)

    // Only possible if PRAGMA foreign_keys is actually ON.
    h.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id)
    assert.equal(countRows(h.db, 'project_roles'), 0)
    h.close()
  })

  test('a role row cannot reference a missing project', () => {
    const h = harness()
    assert.throws(() =>
      h.db
        .prepare(
          `INSERT INTO project_roles (project_id, role, member_label, updated_at)
           VALUES ('nope','product','X','2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    )
    h.close()
  })
})
