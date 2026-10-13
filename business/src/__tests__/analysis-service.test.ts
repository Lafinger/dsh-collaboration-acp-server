import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './harness.js'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { MaterialService } from '../service/material-service.js'
import { AnalysisService } from '../service/analysis-service.js'
import { CollaborationError } from '../domain/error.js'
import { DEFAULT_CONTENT_LIMIT_BYTES } from '../domain/analysis.js'

interface Env {
  db: DatabaseSync
  materials: MaterialService
  analyses: AnalysisService
  base: string
  projectId: string
  /** Upload a file and return its material id + version. */
  upload(name: string, content: string, purpose?: string): { materialId: string; version: number }
  write(name: string, content: string): string
  cleanup(): void
}

function env(): Env {
  const base = tempDir('wb-m3-')
  const fileRoot = join(base, 'fileRoot')
  const outside = join(base, 'outside')
  mkdirSync(fileRoot, { recursive: true })
  mkdirSync(outside, { recursive: true })

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const projects = new ProjectService(db)
  const materials = new MaterialService(db, fileRoot)
  const analyses = new AnalysisService(db, materials)
  const project = projects.create({ key: 'ALPHA', name: 'Alpha' })

  const write = (name: string, content: string): string => {
    const path = join(outside, name)
    writeFileSync(path, content, 'utf8')
    return path
  }

  return {
    db,
    materials,
    analyses,
    base,
    projectId: project.id,
    upload(name, content, purpose = 'p') {
      const result = materials.upload({
        projectId: project.id,
        sourcePath: write(name, content),
        purpose,
        submittedBy: 'Zhang',
      })
      return { materialId: result.material.id, version: result.version.version }
    },
    write,
    cleanup() {
      // The temp directory is removed by the global exit hook in harness.ts, so a failing
      // assertion cannot leak it.
      db.close()
    },
  }
}

describe('scope is enforced by reading, not by promise (MVP-013)', () => {
  test('readScope returns content ONLY for the declared versions', () => {
    const e = env()
    const a = e.upload('a.txt', 'CONTENT A v1')
    e.materials.upload({
      projectId: e.projectId,
      sourcePath: e.write('a.txt', 'CONTENT A v2 SECRET'),
      purpose: 'p',
      submittedBy: 'Z',
    })
    const b = e.upload('b.txt', 'CONTENT B')

    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [{ materialId: a.materialId, version: 1 }, { materialId: b.materialId, version: 1 }],
    })

    const byId = new Map(outcome.contents.map((c) => [`${c.materialId}@${c.version}`, c.content]))
    assert.equal(byId.get(`${a.materialId}@1`), 'CONTENT A v1')
    assert.equal(byId.get(`${b.materialId}@1`), 'CONTENT B')
    // v2 of material A is NOT in scope, so its content is simply not present.
    assert.equal(byId.has(`${a.materialId}@2`), false)
    assert.equal(
      outcome.contents.some((c) => c.content.includes('SECRET')),
      false,
      'out-of-scope content must never be returned',
    )
    e.cleanup()
  })

  test('a reference to an out-of-scope version cannot be read at all', () => {
    const e = env()
    const a = e.upload('a.txt', 'v1')
    e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('a.txt', 'v2'), purpose: 'p', submittedBy: 'Z',
    })

    // Reading only v1 gives no route to v2's bytes — the caller must ask for it explicitly.
    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [{ materialId: a.materialId, version: 1 }],
    })
    assert.equal(outcome.contents.length, 1)
    assert.equal(outcome.contents[0]?.content, 'v1')
    assert.equal(outcome.contents[0]?.version, 1)
    e.cleanup()
  })

  test('an empty scope is refused', () => {
    const e = env()
    assert.throws(
      () => e.analyses.readScope({ projectId: e.projectId, scope: [] }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'SCOPE_REQUIRED',
    )
    e.cleanup()
  })

  test('the scope is de-duplicated', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [
        { materialId: a.materialId, version: 1 },
        { materialId: a.materialId, version: 1 },
      ],
    })
    assert.equal(outcome.scope.length, 1)
    assert.equal(outcome.contents.length, 1)
    e.cleanup()
  })
})

describe('objective gaps are recorded by the server (MVP-015)', () => {
  test('a missing version is reported as uncovered with a machine-readable reason', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [{ materialId: a.materialId, version: 99 }],
    })

    assert.equal(outcome.contents.length, 0)
    assert.equal(outcome.uncovered.length, 1)
    assert.equal(outcome.uncovered[0]?.reason, 'version_missing')
    assert.equal(outcome.uncovered[0]?.entry?.version, 99)
    e.cleanup()
  })

  test('a non-existent material is reported as material_missing', () => {
    const e = env()
    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [{ materialId: 'deadbeef', version: 1 }],
    })
    assert.equal(outcome.uncovered[0]?.reason, 'material_missing')
    e.cleanup()
  })

  test('a file missing from storage is reported as unreadable', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const read = e.materials.read({ materialId: a.materialId, version: 1 })
    unlinkSync(read.absolutePath)

    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [{ materialId: a.materialId, version: 1 }],
    })
    assert.equal(outcome.uncovered[0]?.reason, 'unreadable')
    e.cleanup()
  })

  test('an over-limit file is NOT truncated — it becomes uncovered', () => {
    const e = env()
    const small = e.upload('small.txt', 'tiny')
    const big = e.upload('big.txt', 'x'.repeat(DEFAULT_CONTENT_LIMIT_BYTES + 10))

    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [
        { materialId: small.materialId, version: 1 },
        { materialId: big.materialId, version: 1 },
      ],
    })

    assert.equal(outcome.contents.length, 1, 'only the small one is returned')
    assert.equal(outcome.contents[0]?.materialId, small.materialId)
    const gap = outcome.uncovered.find((u) => u.entry?.materialId === big.materialId)
    assert.equal(gap?.reason, 'too_large')
    // The decisive part: no partial content leaked through.
    assert.equal(
      outcome.contents.some((c) => c.materialId === big.materialId),
      false,
    )
    e.cleanup()
  })

  test('the size limit is configurable', () => {
    const e = env()
    const a = e.upload('a.txt', 'x'.repeat(100))
    const outcome = e.analyses.readScope({
      projectId: e.projectId,
      scope: [{ materialId: a.materialId, version: 1 }],
      limitBytes: 10,
    })
    assert.equal(outcome.uncovered[0]?.reason, 'too_large')
    e.cleanup()
  })
})

describe('submit: source validation (MVP-014)', () => {
  test('a requirement must cite at least one source', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    assert.throws(
      () => e.analyses.submit({
        projectId: e.projectId,
        trigger: 'why',
        scope: [{ materialId: a.materialId, version: 1 }],
        requirements: [{ text: 'must be fast', sources: [] }],
        undecided: [],
        inferences: [],
        notUnderstood: [],
        basisMissing: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'SOURCE_REQUIRED',
    )
    e.cleanup()
  })

  test('a source OUTSIDE the scope is refused as a fabricated basis', () => {
    const e = env()
    const a = e.upload('a.txt', 'v1')
    const b = e.upload('b.txt', 'other')

    assert.throws(
      () => e.analyses.submit({
        projectId: e.projectId,
        trigger: 'why',
        scope: [{ materialId: a.materialId, version: 1 }],
        // b is a real material, but it was never in scope.
        requirements: [{ text: 'claim', sources: [{ materialId: b.materialId, version: 1 }] }],
        undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'SOURCE_OUT_OF_SCOPE',
    )
    e.cleanup()
  })

  test('a source version outside the scope of a material IN scope is refused', () => {
    const e = env()
    const a = e.upload('a.txt', 'v1')
    e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('a.txt', 'v2'), purpose: 'p', submittedBy: 'Z',
    })

    assert.throws(
      () => e.analyses.submit({
        projectId: e.projectId,
        trigger: 'why',
        scope: [{ materialId: a.materialId, version: 1 }],
        // Same material, but version 2 was never declared.
        requirements: [{ text: 'claim', sources: [{ materialId: a.materialId, version: 2 }] }],
        undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'SOURCE_OUT_OF_SCOPE',
    )
    e.cleanup()
  })

  test('a well-formed submission is stored and readable', () => {
    const e = env()
    const a = e.upload('a.txt', 'the material says X')

    const analysis = e.analyses.submit({
      projectId: e.projectId,
      trigger: '初始材料分析',
      scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [{ text: 'X must hold', sources: [{ materialId: a.materialId, version: 1 }] }],
      undecided: ['budget unknown'],
      inferences: ['probably needs a designer'],
      notUnderstood: ['page 3 is a photo'],
      basisMissing: ['no deadline given'],
    })

    const round = e.analyses.get(analysis.id)
    assert.equal(round.trigger, '初始材料分析')
    assert.equal(round.requirements.length, 1)
    assert.equal(round.requirements[0]?.text, 'X must hold')
    assert.deepEqual(round.requirements[0]?.sources, [{ materialId: a.materialId, version: 1 }])
    assert.deepEqual(round.undecided, ['budget unknown'])
    assert.deepEqual(round.inferences, ['probably needs a designer'])
    e.cleanup()
  })
})

describe('submit: objective gaps cannot be omitted', () => {
  test('a read failure appears in uncovered even though the caller never mentioned it', () => {
    const e = env()
    const ok = e.upload('ok.txt', 'fine')
    const broken = e.upload('broken.txt', 'will vanish')
    unlinkSync(e.materials.read({ materialId: broken.materialId, version: 1 }).absolutePath)

    const analysis = e.analyses.submit({
      projectId: e.projectId,
      trigger: 't',
      scope: [
        { materialId: ok.materialId, version: 1 },
        { materialId: broken.materialId, version: 1 },
      ],
      // The caller claims nothing was missed.
      requirements: [{ text: 'r', sources: [{ materialId: ok.materialId, version: 1 }] }],
      undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    })

    const serverGap = analysis.uncovered.find((u) => u.reason === 'unreadable')
    assert.ok(serverGap !== undefined, 'the server must record the failure the caller omitted')
    assert.equal(serverGap.entry?.materialId, broken.materialId)
    e.cleanup()
  })

  test('a too-large file appears in uncovered even though the caller never mentioned it', () => {
    const e = env()
    const big = e.upload('big.txt', 'x'.repeat(DEFAULT_CONTENT_LIMIT_BYTES + 1))

    const analysis = e.analyses.submit({
      projectId: e.projectId,
      trigger: 't',
      scope: [{ materialId: big.materialId, version: 1 }],
      requirements: [],
      undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    })

    assert.equal(analysis.uncovered[0]?.reason, 'too_large')
    assert.equal(analysis.requirements.length, 0, 'all three kinds may be empty')
    e.cleanup()
  })

  test('the three content kinds may all be empty, but uncovered is always present', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const analysis = e.analyses.submit({
      projectId: e.projectId,
      trigger: 'nothing to say',
      scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [], undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    })

    assert.deepEqual(analysis.requirements, [])
    assert.deepEqual(analysis.undecided, [])
    assert.deepEqual(analysis.inferences, [])
    // Present, and empty — an explicit claim that everything was covered.
    assert.deepEqual(analysis.uncovered, [])
    e.cleanup()
  })

  test('reads record what was actually read, with its hash', () => {
    const e = env()
    const a = e.upload('a.txt', 'payload')
    const analysis = e.analyses.submit({
      projectId: e.projectId, trigger: 't',
      scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [], undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    })

    const read = analysis.reads[0]
    assert.equal(read?.ok, true)
    assert.equal(read?.originalName, 'a.txt')
    assert.equal(read?.size, 7)
    assert.equal(read?.sha256?.length, 64)
    // The recorded hash is the real hash of the stored bytes.
    assert.equal(read?.sha256, e.materials.read({ materialId: a.materialId, version: 1 }).version.sha256)
    e.cleanup()
  })
})

describe('no partial analysis, no revisions', () => {
  test('an abandoned readScope leaves NOTHING behind', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')

    e.analyses.readScope({
      projectId: e.projectId,
      scope: [{ materialId: a.materialId, version: 1 }],
    })

    const rows = (): number =>
      Number((e.db.prepare('SELECT COUNT(*) c FROM analyses').get() as { c: number }).c)
    assert.equal(rows(), 0, 'reading a scope must not create a record')
    e.cleanup()
  })

  test('a rejected submission leaves nothing behind', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const b = e.upload('b.txt', 'y')

    assert.throws(() => e.analyses.submit({
      projectId: e.projectId, trigger: 't',
      scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [{ text: 'r', sources: [{ materialId: b.materialId, version: 1 }] }],
      undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    }))

    for (const table of ['analyses', 'analysis_scope', 'analysis_reads', 'analysis_requirements']) {
      const c = Number((e.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c)
      assert.equal(c, 0, `${table} must be empty after a rejected submit`)
    }
    e.cleanup()
  })

  test('the same scope may be analysed more than once, independently', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const scope = [{ materialId: a.materialId, version: 1 }]

    const first = e.analyses.submit({
      projectId: e.projectId, trigger: 'first look', scope,
      requirements: [], undecided: ['v1'], inferences: [], notUnderstood: [], basisMissing: [],
    })
    const second = e.analyses.submit({
      projectId: e.projectId, trigger: 'second look', scope,
      requirements: [], undecided: ['changed my mind'], inferences: [], notUnderstood: [], basisMissing: [],
    })

    assert.notEqual(first.id, second.id)
    assert.deepEqual(first.undecided, ['v1'])
    assert.deepEqual(second.undecided, ['changed my mind'])
    assert.equal(e.analyses.listByProject(e.projectId).length, 2)
    e.cleanup()
  })

  test('a submission with no requirements still records its trigger and scope', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const analysis = e.analyses.submit({
      projectId: e.projectId, trigger: 'because', scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [], undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    })
    assert.equal(analysis.trigger, 'because')
    assert.deepEqual(analysis.scope, [{ materialId: a.materialId, version: 1 }])
    e.cleanup()
  })

  test('the trigger is required', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    assert.throws(() => e.analyses.submit({
      projectId: e.projectId, trigger: '  ', scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [], undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    }), /trigger is required/)
    e.cleanup()
  })
})

describe('advice never becomes a plan (MVP-016)', () => {
  test('submitting an analysis writes nothing into any plan table', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    e.analyses.submit({
      projectId: e.projectId, trigger: 't', scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [{ text: 'r', sources: [{ materialId: a.materialId, version: 1 }] }],
      undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
    })

    // M4 legitimately owns the plan tables, so "no such table exists" would assert the
    // wrong thing. MVP-016 forbids an analysis CREATING a plan — so assert the plan tables
    // stay EMPTY, which holds however M4 evolves.
    const existing = (e.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as unknown as { name: string }[]).map((r) => r.name)

    const planTables = existing.filter((t) => /^(plan|confirmation)/.test(t))
    for (const table of planTables) {
      const count = Number((e.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c)
      assert.equal(count, 0, `${table} must stay empty after an analysis (MVP-016)`)
    }
    e.cleanup()
  })

  test('undecided items carry no status and cannot be resolved', () => {
    const e = env()
    const a = e.upload('a.txt', 'x')
    const analysis = e.analyses.submit({
      projectId: e.projectId, trigger: 't', scope: [{ materialId: a.materialId, version: 1 }],
      requirements: [], undecided: ['unknown budget'], inferences: [], notUnderstood: [], basisMissing: [],
    })

    // Undecided is a plain string list — no shape exists in which a lifecycle could hide.
    assert.deepEqual(analysis.undecided, ['unknown budget'])
    const columns = (e.db.prepare('PRAGMA table_info(analysis_undecided)').all() as unknown as {
      name: string
    }[]).map((c) => c.name)
    assert.deepEqual(columns, ['analysis_id', 'position', 'text'])
    e.cleanup()
  })
})
