import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tempDir } from './harness.js'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { MaterialRepository } from '../sqlite/material-repository.js'
import { ProjectService, systemClock } from '../service/project-service.js'
import { MaterialService } from '../service/material-service.js'
import { FileRoot, versionFileName, assertSafeSegment } from '../service/file-root.js'
import { CollaborationError } from '../domain/error.js'

interface Env {
  db: DatabaseSync
  projects: ProjectService
  materials: MaterialService
  /** Directory that the storage root lives under, plus a sibling "outside" area. */
  base: string
  fileRoot: string
  outside: string
  projectId: string
  write(name: string, content: string, dir?: string): string
  cleanup(): void
}

function env(): Env {
  const base = tempDir('wb-m2-')
  const fileRoot = join(base, 'fileRoot')
  const outside = join(base, 'outside')
  mkdirSync(fileRoot, { recursive: true })
  mkdirSync(outside, { recursive: true })

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const projects = new ProjectService(db, systemClock)
  const materials = new MaterialService(db, fileRoot, systemClock)
  const project = projects.create({ key: 'ALPHA', name: 'Alpha' })

  return {
    db,
    projects,
    materials,
    base,
    fileRoot,
    outside,
    projectId: project.id,
    write(name, content, dir) {
      const path = join(dir ?? outside, name)
      writeFileSync(path, content, 'utf8')
      return path
    },
    cleanup() {
      // The temp directory is removed by the global exit hook in harness.ts, so a failing
      // assertion cannot leak it.
      db.close()
    },
  }
}

describe('upload and immutable versions', () => {
  test('MVP-006: records name, purpose, submitter and role', () => {
    const e = env()
    const src = e.write('spec.md', 'hello')
    const result = e.materials.upload({
      projectId: e.projectId,
      sourcePath: src,
      purpose: '需求说明',
      submittedBy: 'Zhang',
      role: 'product',
    })

    assert.equal(result.created, true)
    assert.equal(result.material.originalName, 'spec.md')
    assert.equal(result.material.purpose, '需求说明')
    assert.equal(result.material.submittedBy, 'Zhang')
    assert.equal(result.material.role, 'product')
    assert.equal(result.version.version, 1)
    e.cleanup()
  })

  test('MVP-007: re-uploading appends a version and does NOT overwrite the old one', () => {
    const e = env()
    const first = e.materials.upload({
      projectId: e.projectId,
      sourcePath: e.write('spec.md', 'v1 content'),
      purpose: '需求说明',
      submittedBy: 'Zhang',
    })
    const second = e.materials.upload({
      projectId: e.projectId,
      sourcePath: e.write('spec.md', 'v2 content is longer'),
      purpose: '需求说明',
      submittedBy: 'Zhang',
    })

    assert.equal(first.created, true)
    assert.equal(second.created, false, 'same name + purpose must be the SAME material')
    assert.equal(first.version.version, 1)
    assert.equal(second.version.version, 2)

    // Both versions must exist on disk, with their original bytes.
    const v1 = e.materials.read({ materialId: first.material.id, version: 1 })
    const v2 = e.materials.read({ materialId: first.material.id, version: 2 })
    assert.equal(v1.content, 'v1 content')
    assert.equal(v2.content, 'v2 content is longer')
    assert.equal(v1.version.sha256 === v2.version.sha256, false)
    e.cleanup()
  })

  test('version directories and file names are distinct per version', () => {
    const e = env()
    const a = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'a'), purpose: 'p', submittedBy: 'Z',
    })
    const b = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'bb'), purpose: 'p', submittedBy: 'Z',
    })

    assert.notEqual(a.version.relPath, b.version.relPath)
    assert.match(a.version.relPath, /materials\/[0-9a-f]{32}\/v1__spec\.md$/)
    assert.match(b.version.relPath, /materials\/[0-9a-f]{32}\/v2__spec\.md$/)
    e.cleanup()
  })

  test('relPath is relative (portable) and the bytes on disk match the hash', () => {
    const e = env()
    const src = e.write('spec.md', 'payload')
    const { version } = e.materials.upload({
      projectId: e.projectId, sourcePath: src, purpose: 'p', submittedBy: 'Z',
    })

    assert.equal(version.relPath.startsWith('ALPHA/'), true)
    assert.equal(/^[a-zA-Z]:/.test(version.relPath), false, 'must not be absolute')

    const onDisk = readFileSync(join(e.fileRoot, ...version.relPath.split('/')), 'utf8')
    assert.equal(onDisk, 'payload')
    e.cleanup()
  })

  test('MVP-010: same name with a different purpose is a different material', () => {
    const e = env()
    const a = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'x'), purpose: '需求说明', submittedBy: 'Z',
    })
    const b = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'y'), purpose: '参考资料', submittedBy: 'Z',
    })

    assert.notEqual(a.material.id, b.material.id)
    assert.equal(a.version.version, 1)
    assert.equal(b.version.version, 1, 'each material has its own version sequence')
    assert.equal(e.materials.listByProject(e.projectId).length, 2)
    e.cleanup()
  })

  test('awkward filenames survive: spaces, brackets, unicode', () => {
    const e = env()
    const name = '设计稿 v1 (最终版).txt'
    const { version } = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write(name, 'content'), purpose: 'p', submittedBy: 'Z',
    })

    assert.match(version.relPath, /v1__设计稿 v1 \(最终版\)\.txt$/)
    const read = e.materials.read({ materialId: version.materialId, version: 1 })
    assert.equal(read.content, 'content')
    e.cleanup()
  })

  test('binary content round-trips byte-for-byte', () => {
    const e = env()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])
    const src = join(e.outside, 'binary.png')
    writeFileSync(src, bytes)

    const { version } = e.materials.upload({
      projectId: e.projectId, sourcePath: src, purpose: 'p', submittedBy: 'Z',
    })
    const stored = readFileSync(join(e.fileRoot, ...version.relPath.split('/')))
    assert.equal(Buffer.compare(stored, bytes), 0)
    e.cleanup()
  })

  test('materials with no role are filed under _shared', () => {
    const e = env()
    const { version } = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('x.txt', 'x'), purpose: 'p', submittedBy: 'Z',
    })
    assert.match(version.relPath, /^ALPHA\/_shared\/materials\//)
    e.cleanup()
  })

  test('archived projects refuse uploads', () => {
    const e = env()
    e.projects.archive(e.projectId)
    assert.throws(
      () => e.materials.upload({
        projectId: e.projectId, sourcePath: e.write('x.txt', 'x'), purpose: 'p', submittedBy: 'Z',
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'PROJECT_ARCHIVED',
    )
    e.cleanup()
  })
})

describe('source handling and failure atomicity', () => {
  test('a missing source is refused', () => {
    const e = env()
    assert.throws(
      () => e.materials.upload({
        projectId: e.projectId, sourcePath: join(e.outside, 'nope.txt'), purpose: 'p', submittedBy: 'Z',
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'SOURCE_NOT_FOUND',
    )
    e.cleanup()
  })

  test('a refused upload leaves NO file and NO row', () => {
    const e = env()
    assert.throws(() => e.materials.upload({
      projectId: e.projectId, sourcePath: join(e.outside, 'nope.txt'), purpose: 'p', submittedBy: 'Z',
    }))

    const rows = e.db.prepare('SELECT COUNT(*) c FROM materials').get() as { c: number }
    const versions = e.db.prepare('SELECT COUNT(*) c FROM material_versions').get() as { c: number }
    assert.equal(Number(rows.c), 0)
    assert.equal(Number(versions.c), 0)

    // And nothing was written into the storage root either.
    const leftover: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else leftover.push(full)
      }
    }
    walk(e.fileRoot)
    assert.deepEqual(leftover, [], 'a failed upload must not leave files behind')
    e.cleanup()
  })

  test('a directory is not a valid source', () => {
    const e = env()
    const dir = join(e.outside, 'a-directory')
    mkdirSync(dir)
    assert.throws(
      () => e.materials.upload({
        projectId: e.projectId, sourcePath: dir, purpose: 'p', submittedBy: 'Z',
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'SOURCE_NOT_A_FILE',
    )
    e.cleanup()
  })

  test('purpose and submitter are required', () => {
    const e = env()
    const src = e.write('x.txt', 'x')
    assert.throws(() => e.materials.upload({
      projectId: e.projectId, sourcePath: src, purpose: '   ', submittedBy: 'Z',
    }), /purpose is required/)
    assert.throws(() => e.materials.upload({
      projectId: e.projectId, sourcePath: src, purpose: 'p', submittedBy: '',
    }), /submittedBy is required/)
    e.cleanup()
  })

  test('an unknown project is refused', () => {
    const e = env()
    assert.throws(
      () => e.materials.upload({
        projectId: 'nope', sourcePath: e.write('x.txt', 'x'), purpose: 'p', submittedBy: 'Z',
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'PROJECT_NOT_FOUND',
    )
    e.cleanup()
  })
})

describe('fixed references (MVP-009)', () => {
  test('reading an old version returns the OLD content after an update', () => {
    const e = env()
    const first = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'ORIGINAL'), purpose: 'p', submittedBy: 'Z',
    })
    e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'REPLACED LATER'), purpose: 'p', submittedBy: 'Z',
    })

    // The whole point: the reference is NOT upgraded to the latest.
    const reread = e.materials.read({ materialId: first.material.id, version: 1 })
    assert.equal(reread.content, 'ORIGINAL')
    assert.equal(reread.version.version, 1)
    e.cleanup()
  })

  test('a reference to a non-existent version fails rather than falling back', () => {
    const e = env()
    const { material } = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'x'), purpose: 'p', submittedBy: 'Z',
    })

    assert.throws(
      () => e.materials.resolveReference({ materialId: material.id, version: 99 }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'VERSION_NOT_FOUND',
    )
    e.cleanup()
  })

  test('listing reports every version in order', () => {
    const e = env()
    const src = e.write('spec.md', '1')
    const first = e.materials.upload({
      projectId: e.projectId, sourcePath: src, purpose: 'p', submittedBy: 'Z',
    })
    e.materials.upload({ projectId: e.projectId, sourcePath: e.write('spec.md', '22'), purpose: 'p', submittedBy: 'Z' })
    e.materials.upload({ projectId: e.projectId, sourcePath: e.write('spec.md', '333'), purpose: 'p', submittedBy: 'Z' })

    const withVersions = e.materials.getWithVersions(first.material.id)
    assert.deepEqual(withVersions.versions.map((v) => v.version), [1, 2, 3])
    assert.equal(withVersions.latestVersion, 3)
    e.cleanup()
  })

  test('MVP-011: a missing stored file reports a reason, not empty content', () => {
    const e = env()
    const { material, version } = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'x'), purpose: 'p', submittedBy: 'Z',
    })

    // Simulate external loss of the stored file.
    rmSync(join(e.fileRoot, ...version.relPath.split('/')))

    const read = e.materials.read({ materialId: material.id, version: 1 })
    assert.equal(read.content, null, 'must NOT be reported as empty content')
    assert.match(String(read.issue), /missing/)
    e.cleanup()
  })
})

describe('storage root guard (ADR-0004)', () => {
  test('FileRoot keeps legitimate paths inside', () => {
    const root = new FileRoot(join(tmpdir(), 'fr'))
    const p = root.resolve('ALPHA', 'product', 'materials', 'abc', 'v1__x.txt')
    assert.equal(p.startsWith(root.root), true)
  })

  /**
   * The containment check must be provably load-bearing on its own.
   *
   * `assertSafeSegment` rejects every hostile segment before containment is consulted, so
   * without this test the containment check is unreachable under test — a mutation that
   * disabled it would leave the suite green (which is exactly what happened, and what the
   * mutation run exposed). `contains()` is the extracted guard, tested directly.
   */
  test('contains() is the second line of defence and works on its own', () => {
    const root = new FileRoot(join(tmpdir(), 'fr'))

    assert.equal(root.contains(join(root.root, 'ALPHA', 'v1__x.txt')), true)
    assert.equal(root.contains(root.root), true)
    // The cases assertSafeSegment would normally catch first:
    assert.equal(root.contains(join(root.root, '..', 'ESCAPED', 'x.txt')), false)
    assert.equal(root.contains(resolve(root.root, '..', '..', 'elsewhere')), false)
    assert.equal(root.contains(join(tmpdir(), 'totally-elsewhere', 'x.txt')), false)
    assert.equal(root.contains('C:/Windows/Temp/x.txt'), false)
  })

  test('an absolute original name is neutralised, not honoured', () => {
    const e = env()
    const absolute = join(e.outside, 'evil.txt')

    // versionFileName collapses separators, so the name becomes ONE safe segment rather
    // than an escape. The upload succeeds but lands inside the root under a flattened name
    // — which is the correct outcome: the caller's absolute path must not steer the write.
    const result = e.materials.upload({
      projectId: e.projectId,
      sourcePath: e.write('x.txt', 'x'),
      originalName: absolute,
      purpose: 'p',
      submittedBy: 'Z',
    })

    assert.equal(result.version.relPath.includes('evil'), true, 'name is recorded, flattened')
    assert.equal(/^[a-zA-Z]:/.test(result.version.relPath), false)
    assert.equal(result.absolutePath.startsWith(e.materials.root), true)
    // The decisive assertion: the write landed under the storage root, not at the
    // absolute path the caller supplied.
    assert.equal(existsSync(join(e.outside, 'v1__evil.txt')), false)
    assert.equal(result.absolutePath, join(e.materials.root, ...result.version.relPath.split('/')))
    e.cleanup()
  })

  test('a traversal project id is REFUSED', () => {
    const root = new FileRoot(join(tmpdir(), 'fr'))
    for (const hostile of ['../../../../ESCAPED', '..\\..\\ESCAPED', '..', '.', 'a/b', 'a\\b']) {
      assert.throws(
        () => root.resolve(hostile, 'product', 'materials', '1'),
        (err: unknown) => err instanceof CollaborationError &&
          (err.code === 'PATH_ESCAPES_FILE_ROOT' || err.code === 'INVALID_ARGUMENT'),
        `expected ${JSON.stringify(hostile)} to be refused`,
      )
    }
  })

  test('a traversal role or filename is REFUSED', () => {
    const root = new FileRoot(join(tmpdir(), 'fr'))
    assert.throws(() => root.resolve('ALPHA', '../..', 'materials', '1'))
    assert.throws(() => root.resolve('ALPHA', '_shared', 'materials', '..'))
  })

  test('relativeOf refuses a path outside the root instead of returning ".."', () => {
    const root = new FileRoot(join(tmpdir(), 'fr'))
    // The trap: path.relative would return "..\\..\\..." silently.
    assert.throws(
      () => root.relativeOf(join(tmpdir(), 'somewhere-else', 'x.txt')),
      (err: unknown) => err instanceof CollaborationError && err.code === 'PATH_ESCAPES_FILE_ROOT',
    )
  })

  test('assertSafeSegment rejects separators, traversal and drive letters', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'C:', 'C:\\x', 'a\0b']) {
      assert.throws(() => assertSafeSegment(bad), `expected ${JSON.stringify(bad)} to be refused`)
    }
    assertSafeSegment('ALPHA')
    assertSafeSegment('_shared')
    assertSafeSegment('v1__设计稿 v1 (最终版).txt')
  })

  test('a hostile project id cannot make the service write outside the root', () => {
    const e = env()
    // Insert a project whose KEY contains traversal, bypassing create()'s validation —
    // this simulates a corrupted row, the strongest form of the attack.
    e.db.prepare(
      `INSERT INTO projects (id, key, name, background, goal, archived_at, created_at)
       VALUES ('evil','../../../../ESCAPED','E',NULL,NULL,NULL,'2026-01-01T00:00:00.000Z')`,
    ).run()

    assert.throws(
      () => e.materials.upload({
        projectId: 'evil', sourcePath: e.write('x.txt', 'x'), purpose: 'p', submittedBy: 'Z',
      }),
      (err: unknown) => err instanceof CollaborationError &&
        (err.code === 'PATH_ESCAPES_FILE_ROOT' || err.code === 'INVALID_ARGUMENT'),
    )

    // Nothing escaped, and no row was written.
    assert.equal(existsSync(join(e.base, 'ESCAPED')), false)
    assert.equal(existsSync(resolve(e.fileRoot, '..', '..', 'ESCAPED')), false)
    const versions = e.db.prepare('SELECT COUNT(*) c FROM material_versions').get() as { c: number }
    assert.equal(Number(versions.c), 0)
    e.cleanup()
  })
})

describe('version allocation is race-safe', () => {
  test('version numbers come from MAX+1 inside the transaction, not COUNT', () => {
    const e = env()
    const src = e.write('spec.md', 'x')
    const first = e.materials.upload({
      projectId: e.projectId, sourcePath: src, purpose: 'p', submittedBy: 'Z',
    })

    // Simulate the interleaving that broke the naive COUNT(*)+1 implementation: read the
    // "next" version from two racing callers before either writes.
    const repo = new MaterialRepository(e.db)
    const a = repo.latestVersion(first.material.id) + 1
    const b = repo.latestVersion(first.material.id) + 1
    assert.equal(a, b, 'two racing readers DO see the same value — hence the transaction')

    // The unique index is the real backstop.
    assert.throws(() =>
      e.db.prepare(
        `INSERT INTO material_versions (material_id, version, rel_path, size, sha256, issue, created_at)
         VALUES (?, 1, 'ALPHA/_shared/materials/x/v1__dup.txt', 1, '', NULL, 'now')`,
      ).run(first.material.id),
    )
    e.cleanup()
  })

  /**
   * MAX+1 and COUNT+1 agree only while no version is ever missing. This test makes them
   * DIVERGE by deleting a middle version row, so an implementation that mistakes one for
   * the other is caught (a mutation swapping them previously left the suite green).
   */
  test('a version number is never reused after a gap (MAX, not COUNT)', () => {
    const e = env()
    const src = e.write('spec.md', 'a')
    const first = e.materials.upload({
      projectId: e.projectId, sourcePath: src, purpose: 'p', submittedBy: 'Z',
    })
    e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'bb'), purpose: 'p', submittedBy: 'Z',
    })

    // Remove version 1, leaving only version 2. COUNT would now say "1 row -> next is 2",
    // reusing a number that already exists; MAX correctly says "next is 3".
    e.db.prepare('DELETE FROM material_versions WHERE material_id = ? AND version = 1').run(first.material.id)

    const third = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'ccc'), purpose: 'p', submittedBy: 'Z',
    })
    assert.equal(third.version.version, 3, 'must continue from the MAX, never reuse a number')
    assert.deepEqual(
      e.materials.getWithVersions(first.material.id).versions.map((v) => v.version),
      [2, 3],
    )
    e.cleanup()
  })

  test('the unique rel_path index prevents two versions sharing one file path', () => {
    const e = env()
    const first = e.materials.upload({
      projectId: e.projectId, sourcePath: e.write('spec.md', 'x'), purpose: 'p', submittedBy: 'Z',
    })

    assert.throws(
      () => e.db.prepare(
        `INSERT INTO material_versions (material_id, version, rel_path, size, sha256, issue, created_at)
         VALUES (?, 99, ?, 1, '', NULL, 'now')`,
      ).run(first.material.id, first.version.relPath),
      /UNIQUE constraint failed/,
    )
    e.cleanup()
  })
})

describe('versionFileName', () => {
  test('embeds the version so two versions never share a name', () => {
    assert.equal(versionFileName(1, 'a.txt'), 'v1__a.txt')
    assert.equal(versionFileName(12, 'a.txt'), 'v12__a.txt')
    assert.notEqual(versionFileName(1, 'a.txt'), versionFileName(2, 'a.txt'))
  })

  test('strips path separators from the original name', () => {
    assert.equal(versionFileName(1, 'a/b.txt'), 'v1__a_b.txt')
    assert.equal(versionFileName(1, 'a\\b.txt'), 'v1__a_b.txt')
  })

  test('falls back to a placeholder for an empty name', () => {
    assert.equal(versionFileName(1, '   '), 'v1__unnamed')
  })

  test('rejects an invalid version number', () => {
    assert.throws(() => versionFileName(0, 'a.txt'))
    assert.throws(() => versionFileName(-1, 'a.txt'))
    assert.throws(() => versionFileName(1.5, 'a.txt'))
  })
})


describe('NLMVP material intake rules', () => {
  test('same latest bytes reuse the existing immutable version', () => {
    const e = env()
    try {
      const input = { projectId: e.projectId, sourcePath: e.write('spec.md', 'same'), purpose: 'requirements', submittedBy: 'A' }
      const a = e.materials.upload(input)
      const b = e.materials.upload(input)
      assert.equal(b.material.id, a.material.id)
      assert.equal(b.version.version, 1, 'same latest bytes must not create v2')
      assert.equal((b as unknown as { deduplicated?: boolean }).deduplicated, true)
      assert.equal(e.materials.getWithVersions(a.material.id).versions.length, 1)
      assert.equal(e.materials.read({ materialId: a.material.id, version: 1 }).content, 'same')
    } finally { e.cleanup() }
  })
  test('historical bytes require new explicit restoration confirmation', () => {
    const e = env()
    try {
      const input = { projectId: e.projectId, sourcePath: e.write('spec.md', 'old'), purpose: 'requirements', submittedBy: 'A' }
      const a = e.materials.upload(input)
      e.write('spec.md', 'new'); e.materials.upload(input); e.write('spec.md', 'old')
      assert.throws(() => e.materials.upload(input), (error: unknown) => error instanceof CollaborationError && String(error.code) === 'MATERIAL_RESTORE_CONFIRMATION_REQUIRED')
      assert.equal(e.materials.getWithVersions(a.material.id).latestVersion, 2)
      assert.equal(e.materials.read({ materialId: a.material.id, version: 1 }).content, 'old')
    } finally { e.cleanup() }
  })
  test('explicit target appends new named source without renaming old material', () => {
    const e = env()
    try {
      const a = e.materials.upload({ projectId: e.projectId, sourcePath: e.write('spec.md', 'old'), purpose: 'requirements', submittedBy: 'A' })
      const input = { projectId: e.projectId, sourcePath: e.write('spec-v2.md', 'new'), purpose: 'requirements', submittedBy: 'B', targetMaterialId: a.material.id, expectedLatestVersion: 1 }
      const b = e.materials.upload(input)
      assert.equal(b.material.id, a.material.id, 'explicit target must not create another material')
      assert.equal(b.material.originalName, 'spec.md')
      assert.equal(b.material.submittedBy, 'A')
      assert.equal(b.version.version, 2)
      assert.equal(e.materials.read({ materialId: a.material.id, version: 1 }).content, 'old')
    } finally { e.cleanup() }
  })
  test('explicit target cannot escape the requested project', () => {
    const e = env()
    try {
      const a = e.materials.upload({ projectId: e.projectId, sourcePath: e.write('spec.md', 'old'), purpose: 'requirements', submittedBy: 'A' })
      const other = e.projects.create({ key: 'BETA', name: 'Beta' })
      const input = { projectId: other.id, sourcePath: e.write('other.md', 'new'), purpose: 'requirements', submittedBy: 'B', targetMaterialId: a.material.id, expectedLatestVersion: 1 }
      assert.throws(() => e.materials.upload(input))
      assert.equal(e.materials.listByProject(other.id).length, 0)
      assert.equal(e.materials.getWithVersions(a.material.id).latestVersion, 1)
    } finally { e.cleanup() }
  })
  test('stale expected latest version refuses without creating rows', () => {
    const e = env()
    try {
      const input = { projectId: e.projectId, sourcePath: e.write('spec.md', 'old'), purpose: 'requirements', submittedBy: 'A' }
      const a = e.materials.upload(input)
      e.write('spec.md', 'middle'); e.materials.upload(input); e.write('spec.md', 'new')
      const stale = { ...input, targetMaterialId: a.material.id, expectedLatestVersion: 1 }
      assert.throws(() => e.materials.upload(stale), (error: unknown) => error instanceof CollaborationError && String(error.code) === 'VERSION_CONFLICT')
      assert.equal(e.materials.getWithVersions(a.material.id).latestVersion, 2)
    } finally { e.cleanup() }
  })
  test('deduplication cannot certify a corrupt stored original', () => {
    const e = env()
    try {
      const input = { projectId: e.projectId, sourcePath: e.write('spec.md', 'same'), purpose: 'requirements', submittedBy: 'A' }
      const a = e.materials.upload(input)
      writeFileSync(a.absolutePath, 'corrupt')
      assert.throws(() => e.materials.upload(input))
      assert.equal(e.materials.getWithVersions(a.material.id).versions.length, 1)
    } finally { e.cleanup() }
  })
})


describe('NLMVP trusted restoration and rollback', () => {
  test('model supplied restoration fields cannot replace separate trusted evidence', () => {
    const e = env()
    try {
      const base = { projectId: e.projectId, sourcePath: e.write('spec.md', 'old'), purpose: 'requirements', submittedBy: 'A' }
      const a = e.materials.upload(base)
      e.write('spec.md', 'new'); e.materials.upload(base); e.write('spec.md', 'old')
      const proposal = { ...base, targetMaterialId: a.material.id, expectedLatestVersion: 2, restoreVersion: 1, authorization: { restore: { materialId: a.material.id, version: 1, expectedLatestVersion: 2 } } }
      assert.throws(() => e.materials.upload(proposal), (error: unknown) => error instanceof CollaborationError && error.code === 'MATERIAL_RESTORE_CONFIRMATION_REQUIRED')
      assert.equal(e.materials.getWithVersions(a.material.id).latestVersion, 2)
      const restored = e.materials.upload(proposal, undefined, { restore: { materialId: a.material.id, version: 1, expectedLatestVersion: 2 } })
      assert.equal(restored.version.version, 3)
      for (const [version, content] of [[1, 'old'], [2, 'new'], [3, 'old']] as const) assert.equal(e.materials.read({ materialId: a.material.id, version }).content, content)
    } finally { e.cleanup() }
  })
  test('wrong trusted target and stale trusted restoration cannot authorize a write', () => {
    const e = env()
    try {
      const input = { projectId: e.projectId, sourcePath: e.write('spec.md', 'old'), purpose: 'requirements', submittedBy: 'A' }
      const a = e.materials.upload(input)
      e.write('spec.md', 'new'); e.materials.upload(input); e.write('spec.md', 'old')
      const proposal = { ...input, targetMaterialId: a.material.id, expectedLatestVersion: 2, restoreVersion: 1 }
      for (const restore of [{ materialId: 'different', version: 1, expectedLatestVersion: 2 }, { materialId: a.material.id, version: 1, expectedLatestVersion: 1 }]) {
        assert.throws(() => e.materials.upload(proposal, undefined, { restore }), (error: unknown) => error instanceof CollaborationError && error.code === 'MATERIAL_RESTORE_CONFIRMATION_REQUIRED')
      }
      assert.equal(e.materials.getWithVersions(a.material.id).versions.length, 2)
    } finally { e.cleanup() }
  })
  test('deduplicated receipt callback participates in transaction without changing original category', () => {
    const e = env()
    try {
      e.db.exec('CREATE TABLE synthetic_receipt_links (receipt TEXT PRIMARY KEY, version INTEGER)')
      const input = { projectId: e.projectId, sourcePath: e.write('spec.md', 'same'), purpose: 'requirements', submittedBy: 'A', role: 'product' as const }
      const first = e.materials.upload(input, result => { e.db.prepare('INSERT INTO synthetic_receipt_links VALUES (?, ?)').run('original', result.version.version) })
      assert.throws(() => e.materials.upload({ ...input, submittedBy: 'B', role: 'backend' }, result => { assert.equal(result.deduplicated, true); e.db.prepare('INSERT INTO synthetic_receipt_links VALUES (?, ?)').run('failed', result.version.version); throw new Error('synthetic association failed') }), /synthetic association failed/)
      assert.equal(e.db.prepare('SELECT COUNT(*) n FROM synthetic_receipt_links').get()?.n, 1)
      const second = e.materials.upload({ ...input, submittedBy: 'B', role: 'backend' }, result => { e.db.prepare('INSERT INTO synthetic_receipt_links VALUES (?, ?)').run('second', result.version.version) })
      assert.equal(second.material.role, 'product')
      assert.equal(second.material.submittedBy, 'A')
      assert.equal(second.deduplicated, true)
      assert.equal(e.db.prepare('SELECT COUNT(*) n FROM synthetic_receipt_links').get()?.n, 2)
      assert.equal(e.materials.getWithVersions(first.material.id).versions.length, 1)
      assert.equal(readFileSync(first.absolutePath, 'utf8'), 'same')
    } finally { e.cleanup() }
  })
  test('existing destination file is never overwritten or removed after refusal', () => {
    const e = env()
    try {
      const input = { projectId: e.projectId, sourcePath: e.write('spec.md', 'old'), purpose: 'requirements', submittedBy: 'A' }
      const first = e.materials.upload(input)
      const occupied = first.absolutePath.replace(/v1__spec\.md$/, 'v2__spec.md')
      assert.notEqual(occupied, first.absolutePath)
      writeFileSync(occupied, 'preexisting-do-not-touch')
      e.write('spec.md', 'new')
      assert.throws(() => e.materials.upload(input))
      assert.equal(readFileSync(occupied, 'utf8'), 'preexisting-do-not-touch')
      assert.equal(e.materials.getWithVersions(first.material.id).versions.length, 1)
      assert.equal(readFileSync(first.absolutePath, 'utf8'), 'old')
    } finally { e.cleanup() }
  })
})
