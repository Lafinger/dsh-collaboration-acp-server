import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, countRows } from './harness.js'
import { CollaborationError } from '../domain/error.js'

const invalid = (error: unknown) => error instanceof CollaborationError && error.code === 'INVALID_ARGUMENT'

test('project details fill one field, retain omitted field, then update both without changing identity or roles', () => {
  const h = harness()
  try {
    const original = h.projects.create({ key: 'DETAILS', name: 'Original' })
    h.projects.setMember(original.id, 'pm', 'alice')
    h.projects.setMember(original.id, 'product', 'alice')
    const other = h.projects.create({ key: 'OTHER', name: 'Other', goal: 'Other goal' })
    const roles = h.projects.getWithRoles(original.id).roles
    const first = h.projects.updateDetails({ projectId: original.id, background: '  Confirmed background  ' })
    assert.equal(first.background, 'Confirmed background')
    assert.equal(first.goal, null)
    assert.deepEqual(first.pendingFields, ['goal'])
    const second = h.projects.updateDetails({ projectId: original.id, goal: '  Confirmed goal  ' })
    assert.equal(second.background, first.background)
    assert.equal(second.goal, 'Confirmed goal')
    assert.deepEqual(second.pendingFields, [])
    const third = h.projects.updateDetails({ projectId: original.id, background: 'Revised background', goal: 'Revised goal' })
    assert.deepEqual(third, { ...original, background: 'Revised background', goal: 'Revised goal', pendingFields: [] })
    assert.deepEqual(h.projects.updateDetails({ projectId: original.id, background: third.background!, goal: third.goal! }), third)
    assert.deepEqual(h.projects.getWithRoles(original.id).roles, roles)
    assert.deepEqual(h.projects.get(other.id), other)
    assert.equal(countRows(h.db, 'projects'), 2)
    for (const table of ['materials', 'analyses', 'plans', 'tasks']) assert.equal(countRows(h.db, table), 0)
  } finally { h.close() }
})

test('details reject empty patch, blank/null/wrong type, unknown fields and oversize without partial write', () => {
  const h = harness()
  try {
    const original = h.projects.create({ key: 'SAFE', name: 'Safe', background: 'Preserve', goal: 'Preserve goal' })
    const update = (patch: Record<string, unknown>) => h.projects.updateDetails({ projectId: original.id, ...patch } as Parameters<typeof h.projects.updateDetails>[0])
    for (const patch of [{}, { background: undefined }, { goal: '' }, { background: '  ' }, { background: null }, { goal: null }, { background: 123 }, { goal: false }, { background: 'x'.repeat(2001) }, { background: 'Would change', goal: 'x'.repeat(2001) }, { name: 'No rename', background: 'Changed' }, { key: 'NO', goal: 'Changed' }, { role: 'pm', goal: 'Changed' }, { archived_at: 'now', goal: 'Changed' }]) {
      assert.throws(() => update(patch), invalid)
      assert.deepEqual(h.projects.get(original.id), original)
    }
    assert.equal(h.projects.updateDetails({ projectId: original.id, background: 'x'.repeat(2000) }).background?.length, 2000)
  } finally { h.close() }
})

test('details reject missing and archived projects; archive gate holds and reads still work', () => {
  const h = harness()
  try {
    assert.throws(() => h.projects.updateDetails({ projectId: 'missing', goal: 'Confirmed' }), (error: unknown) => error instanceof CollaborationError && error.code === 'PROJECT_NOT_FOUND')
    const project = h.projects.create({ key: 'ARCHIVED', name: 'Archived' })
    const archived = h.projects.archive(project.id)
    assert.throws(() => h.projects.updateDetails({ projectId: project.id, background: 'No' }), (error: unknown) => error instanceof CollaborationError && error.code === 'PROJECT_ARCHIVED')
    assert.deepEqual(h.projects.get(project.id), archived)
  } finally { h.close() }
})
