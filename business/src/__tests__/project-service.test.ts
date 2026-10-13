import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { harness, countRows } from './harness.js'
import { CollaborationError } from '../domain/error.js'
import { ROLE_IDS } from '../domain/roles.js'

describe('project_create', () => {
  test('creates a project and returns a generated id', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })

    assert.match(project.id, /^[0-9a-f]{32}$/)
    assert.equal(project.key, 'ALPHA')
    assert.equal(project.name, 'Alpha')
    assert.equal(project.archivedAt, null)
    assert.equal(countRows(h.db, 'projects'), 1)
    h.close()
  })

  test('MVP-001: omitted background and goal stay null, never invented', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })

    assert.equal(project.background, null)
    assert.equal(project.goal, null)
    assert.deepEqual(project.pendingFields, ['background', 'goal'])
    h.close()
  })

  test('MVP-001: a blank string counts as not provided', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha', background: '   ', goal: '' })

    // "not provided" must have exactly ONE representation downstream.
    assert.equal(project.background, null)
    assert.equal(project.goal, null)
    assert.deepEqual(project.pendingFields, ['background', 'goal'])
    h.close()
  })

  test('MVP-001: supplying both clears pendingFields', () => {
    const h = harness()
    const project = h.projects.create({
      key: 'BETA',
      name: 'Beta',
      background: 'why it exists',
      goal: 'what done means',
    })

    assert.deepEqual(project.pendingFields, [])
    assert.equal(project.background, 'why it exists')
    assert.equal(project.goal, 'what done means')
    h.close()
  })

  test('pendingFields is derived, not stored — it cannot go stale', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    assert.deepEqual(project.pendingFields, ['background', 'goal'])

    // Read it back through a fresh query: still derived from the row itself.
    assert.deepEqual(h.projects.get(project.id).pendingFields, ['background', 'goal'])
    h.close()
  })

  test('duplicate key is rejected with PROJECT_EXISTS and writes nothing', () => {
    const h = harness()
    h.projects.create({ key: 'ALPHA', name: 'First' })

    assert.throws(
      () => h.projects.create({ key: 'ALPHA', name: 'Second' }),
      (error: unknown) => {
        assert.ok(error instanceof CollaborationError)
        assert.equal(error.code, 'PROJECT_EXISTS')
        assert.equal(error.details?.key, 'ALPHA')
        return true
      },
    )
    // The rejected write must leave no trace.
    assert.equal(countRows(h.db, 'projects'), 1)
    assert.equal(h.projects.list()[0]?.name, 'First')
    h.close()
  })

  test('key is case-insensitive for uniqueness', () => {
    const h = harness()
    h.projects.create({ key: 'alpha', name: 'First' })
    assert.throws(() => h.projects.create({ key: 'ALPHA', name: 'Second' }), /already in use/)
    assert.equal(countRows(h.db, 'projects'), 1)
    h.close()
  })

  test('key must be path-safe, because it appears in paths and queries', () => {
    const h = harness()
    for (const bad of ['../escape', 'a/b', 'a b', '', '  ', 'a\\b', 'a.b']) {
      assert.throws(
        () => h.projects.create({ key: bad, name: 'X' }),
        (error: unknown) => error instanceof CollaborationError && error.code === 'INVALID_ARGUMENT',
        `expected "${bad}" to be rejected`,
      )
    }
    assert.equal(countRows(h.db, 'projects'), 0)
    h.close()
  })

  test('name is required and bounded', () => {
    const h = harness()
    assert.throws(() => h.projects.create({ key: 'A', name: '  ' }), /name is required/)
    assert.throws(
      () => h.projects.create({ key: 'A', name: 'x'.repeat(201) }),
      /exceeds 200 characters/,
    )
    assert.equal(countRows(h.db, 'projects'), 0)
    h.close()
  })
})

describe('project_get / project_list', () => {
  test('get returns the project with all nine role slots, all vacant initially', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    const withRoles = h.projects.getWithRoles(project.id)

    assert.equal(withRoles.roles.length, ROLE_IDS.length)
    assert.ok(withRoles.roles.every((r) => r.member === null))
    // Every role is reported, including ones with no row — the caller needs the full picture.
    assert.deepEqual(
      withRoles.roles.map((r) => r.role),
      [...ROLE_IDS],
    )
    h.close()
  })

  test('get on a missing id raises PROJECT_NOT_FOUND', () => {
    const h = harness()
    assert.throws(
      () => h.projects.get('deadbeef'),
      (error: unknown) => error instanceof CollaborationError && error.code === 'PROJECT_NOT_FOUND',
    )
    h.close()
  })

  test('list excludes archived unless asked', () => {
    const h = harness()
    const a = h.projects.create({ key: 'A', name: 'A' })
    h.projects.create({ key: 'B', name: 'B' })
    h.projects.archive(a.id)

    assert.deepEqual(
      h.projects.list().map((p) => p.key),
      ['B'],
    )
    assert.equal(h.projects.list(true).length, 2)
    h.close()
  })

  test('archive is idempotent', () => {
    const h = harness()
    const project = h.projects.create({ key: 'A', name: 'A' })
    const first = h.projects.archive(project.id)
    h.tick()
    const second = h.projects.archive(project.id)

    // Re-archiving must not move the timestamp — that would rewrite history.
    assert.equal(first.archivedAt, second.archivedAt)
    h.close()
  })
})

describe('roles and members', () => {
  test('MVP-004: setting a member is a plain label change', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    h.projects.setMember(project.id, 'product', 'Zhang')

    const roles = h.projects.getWithRoles(project.id).roles
    assert.equal(roles.find((r) => r.role === 'product')?.member, 'Zhang')
    // No other slot is touched.
    assert.equal(roles.filter((r) => r.member !== null).length, 1)
    h.close()
  })

  test('MVP-004: changing a member overwrites with no history record', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    h.projects.setMember(project.id, 'product', 'Zhang')
    h.tick()
    h.projects.setMember(project.id, 'product', 'Li')

    assert.equal(h.projects.getWithRoles(project.id).roles.find((r) => r.role === 'product')?.member, 'Li')
    // One row per (project, role) — a mutable label, not an append-only log.
    assert.equal(countRows(h.db, 'project_roles'), 1)
    h.close()
  })

  test('a member may occupy several roles at once', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    h.projects.setMember(project.id, 'product', 'Zhang')
    h.projects.setMember(project.id, 'design', 'Zhang')

    const roles = h.projects.getWithRoles(project.id).roles
    assert.equal(roles.filter((r) => r.member === 'Zhang').length, 2)
    h.close()
  })

  test('passing null vacates the slot', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    h.projects.setMember(project.id, 'product', 'Zhang')
    h.projects.setMember(project.id, 'product', null)

    assert.equal(h.projects.getWithRoles(project.id).roles.find((r) => r.role === 'product')?.member, null)
    h.close()
  })

  test('an unknown role is rejected and writes nothing', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    assert.throws(
      () => h.projects.setMember(project.id, 'manager', 'Zhang'),
      (error: unknown) => error instanceof CollaborationError && error.code === 'ROLE_UNKNOWN',
    )
    assert.equal(countRows(h.db, 'project_roles'), 0)
    h.close()
  })

  test('archived projects refuse member changes', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    h.projects.archive(project.id)

    assert.throws(
      () => h.projects.setMember(project.id, 'product', 'Zhang'),
      (error: unknown) => error instanceof CollaborationError && error.code === 'PROJECT_ARCHIVED',
    )
    assert.equal(countRows(h.db, 'project_roles'), 0)
    // ...but reading still works (MVP-005).
    assert.equal(h.projects.getWithRoles(project.id).archivedAt !== null, true)
    h.close()
  })

  test('member labels are trimmed', () => {
    const h = harness()
    const project = h.projects.create({ key: 'ALPHA', name: 'Alpha' })
    h.projects.setMember(project.id, 'product', '  Zhang  ')
    assert.equal(h.projects.getWithRoles(project.id).roles.find((r) => r.role === 'product')?.member, 'Zhang')
    h.close()
  })
})
