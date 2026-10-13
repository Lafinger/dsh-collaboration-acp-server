/**
 * Schema ownership and versioned migration.
 *
 * `PRAGMA user_version` is the schema version. A database newer than this build is
 * refused rather than guessed at — silently running against an unknown shape is how
 * data gets corrupted.
 */
import { DatabaseSync } from 'node:sqlite';
import { CollaborationError } from '../domain/error.js';
export const SCHEMA_VERSION = 9;
const MIGRATION_1 = `
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  background   TEXT,
  goal         TEXT,
  archived_at  TEXT,
  created_at   TEXT NOT NULL
);

-- One row per (project, role). Roles are a fixed set, but a project may enable only some
-- of them, so rows are created lazily. member_label is a mutable label, never an FK.
CREATE TABLE project_roles (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  member_label TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, role)
);

CREATE INDEX project_roles_member ON project_roles(member_label)
  WHERE member_label IS NOT NULL;
`;
const MIGRATION_2 = `
-- A material is a named work input. Its filing attributes (purpose, role, uploader) are
-- fixed at creation: a later member change must not move files or rewrite history.
CREATE TABLE materials (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  submitted_by  TEXT NOT NULL,
  role          TEXT,
  created_at    TEXT NOT NULL
);

-- The uniqueness that makes "same name, same purpose" mean ONE material rather than two.
CREATE UNIQUE INDEX materials_identity
  ON materials(project_id, original_name, purpose);

CREATE INDEX materials_by_project ON materials(project_id, created_at DESC);

-- Append-only. Versions are never updated or deleted: MVP-007 makes them immutable, and
-- MVP-009 resolves a reference to exactly one of these rows forever.
CREATE TABLE material_versions (
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  rel_path    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  issue       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (material_id, version)
);

-- Backstop for the version allocator. Without this, two racing uploads could both claim
-- version N and one file would silently overwrite the other (verified defect, §7.5).
CREATE UNIQUE INDEX material_versions_path ON material_versions(rel_path);
`;
const MIGRATION_3 = `
-- One row per COMPLETED analysis. There is deliberately no "in progress" state: an
-- abandoned analysis leaves nothing behind.
CREATE TABLE analyses (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX analyses_by_project ON analyses(project_id, created_at DESC);

-- The scope is stored as rows rather than a JSON blob so that "was this version in scope?"
-- is a query, not string parsing. It is the thing the analysis was ALLOWED to read.
CREATE TABLE analysis_scope (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (analysis_id, material_id, version)
);

-- What the server ACTUALLY read. Kept separate from the scope so a gap between the two
-- (declared vs achieved) stays visible instead of being flattened into one list.
CREATE TABLE analysis_reads (
  analysis_id   TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  material_id   TEXT NOT NULL,
  version       INTEGER NOT NULL,
  original_name TEXT,
  sha256        TEXT,
  size          INTEGER,
  ok            INTEGER NOT NULL,
  reason        TEXT,
  read_at       TEXT NOT NULL,
  PRIMARY KEY (analysis_id, material_id, version)
);

-- The three content kinds stay in separate tables, not one table with a 'kind' column.
-- That mirrors the tool contract (three separate parameters) and makes it impossible to
-- "lose" the classification by writing a wrong discriminator.
CREATE TABLE analysis_requirements (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (analysis_id, position)
);

-- A requirement's sources must lie inside the scope. Enforced by the service; the schema
-- keeps them so the claim stays checkable after the fact.
CREATE TABLE analysis_requirement_sources (
  analysis_id TEXT NOT NULL,
  position    INTEGER NOT NULL,
  material_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  PRIMARY KEY (analysis_id, position, material_id, version),
  FOREIGN KEY (analysis_id, position)
    REFERENCES analysis_requirements(analysis_id, position) ON DELETE CASCADE
);

CREATE TABLE analysis_undecided (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (analysis_id, position)
);

CREATE TABLE analysis_inferences (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (analysis_id, position)
);

-- Objective gaps (server-discovered) and subjective ones (analysis-reported) live side by
-- side with a reason code, so the cause is never inferred from prose.
CREATE TABLE analysis_uncovered (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  material_id TEXT,
  version     INTEGER,
  PRIMARY KEY (analysis_id, position)
);
`;
const MIGRATION_4 = `
-- A plan. The id column is the plan identity and is SHARED by all its versions; each
-- version is its own row, so a revision is an APPEND and never an overwrite (MVP-021). The
-- primary key is therefore (id, version) -- keying on id alone would make a second version
-- impossible. activated_at is set at most once, inside the activation transaction.
CREATE TABLE plans (
  id            TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  roles_reason  TEXT NOT NULL,
  roles_overridden INTEGER NOT NULL,
  proposed_roles TEXT,
  source_analysis_id TEXT REFERENCES analyses(id) ON DELETE SET NULL,
  activated_at  TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE INDEX plans_by_project ON plans(project_id, created_at DESC);

-- Relevant roles per plan version. A separate table (not a JSON column) so that "which
-- roles must agree" is queryable and cannot be mis-parsed.
CREATE TABLE plan_roles (
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  role    TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (plan_id, version, role),
  FOREIGN KEY (plan_id, version) REFERENCES plans(id, version) ON DELETE CASCADE
);

-- Proposed task changes. M4 stores the PROPOSAL only; activation gives it a life.
-- task_id is set for modify/cancel (the durable task being changed) and NULL for add
-- (the task does not exist yet). This is the second identifier ADR-0008 introduces.
CREATE TABLE plan_tasks (
  plan_id  TEXT NOT NULL,
  version  INTEGER NOT NULL,
  ref      TEXT NOT NULL,
  task_id  TEXT,
  role     TEXT NOT NULL,
  change   TEXT NOT NULL,
  content  TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (plan_id, version, ref),
  FOREIGN KEY (plan_id, version) REFERENCES plans(id, version) ON DELETE CASCADE
);

-- Dependencies are declared between task refs WITHIN one plan version. Unlike M5's task
-- graph these need no cross-version resolution, which is why cycles are cheap to reject
-- here (MVP-017) — before any confirmation has been collected.
CREATE TABLE plan_task_deps (
  plan_id      TEXT NOT NULL,
  version      INTEGER NOT NULL,
  task_ref     TEXT NOT NULL,
  depends_on   TEXT NOT NULL,
  PRIMARY KEY (plan_id, version, task_ref, depends_on),
  FOREIGN KEY (plan_id, version, task_ref)
    REFERENCES plan_tasks(plan_id, version, ref) ON DELETE CASCADE
);

-- Marks on the plan. No status, no owner, never resolved — same discipline as M3.
CREATE TABLE plan_undecided (
  plan_id  TEXT NOT NULL,
  version  INTEGER NOT NULL,
  position INTEGER NOT NULL,
  text     TEXT NOT NULL,
  PRIMARY KEY (plan_id, version, position),
  FOREIGN KEY (plan_id, version) REFERENCES plans(id, version) ON DELETE CASCADE
);

-- One slot per (plan version, relevant role). Rows are never deleted on revision: they are
-- VOIDED, so the record of what was agreed before the change survives (MVP-021).
-- The FK points at (plan_id, plan_version) so a voided slot from an earlier version stays
-- valid after that version is superseded.
CREATE TABLE confirmations (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  role         TEXT NOT NULL,
  outcome      TEXT,
  reason       TEXT,
  submitted_by TEXT,
  decided_at   TEXT,
  voided_at    TEXT,
  void_reason  TEXT,
  UNIQUE (plan_id, plan_version, role),
  FOREIGN KEY (plan_id, plan_version) REFERENCES plans(id, version) ON DELETE CASCADE
);

CREATE INDEX confirmations_by_plan ON confirmations(plan_id, plan_version);

-- The formal plan, recorded the moment the gate closes. Kept as its own row so "was this
-- plan ever activated" is a fact about the record, not an inference from confirmations.
CREATE TABLE plan_activations (
  plan_id      TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  activated_at TEXT NOT NULL,
  roles        TEXT NOT NULL,
  PRIMARY KEY (plan_id, plan_version),
  FOREIGN KEY (plan_id, plan_version) REFERENCES plans(id, version) ON DELETE CASCADE
);
`;
const MIGRATION_5 = `
-- A task is an execution unit that OUTLIVES the plan which created it. Its id is stable
-- across every version; the plan that created it is not part of its identity.
-- cancelled_at and completed_at are two DIFFERENT terminal states, and a task may be
-- cancelled without ever completing. Neither deletes anything.
CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  cancelled_at   TEXT,
  cancelled_by_plan_id TEXT,
  completed_at   TEXT
);

CREATE INDEX tasks_by_project ON tasks(project_id, created_at);

-- Append-only. A later version never overwrites an earlier one, because a result records
-- the task version it was produced under and that reference must stay resolvable.
-- depends_on holds refs from the SAME plan version (resolved at activation, stored as text
-- because the referenced task may be created in the same transaction).
CREATE TABLE task_versions (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  created_by_plan_id      TEXT NOT NULL,
  created_by_plan_version INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, version)
);

-- The dependency edges of one task version. Separate table so each version's inputs are
-- frozen with it (ADR-0008): a result records the task version, and that must be enough to
-- recover what the inputs were.
CREATE TABLE task_version_deps (
  task_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (task_id, version, depends_on_task_id),
  FOREIGN KEY (task_id, version)
    REFERENCES task_versions(task_id, version) ON DELETE CASCADE
);

-- The activation ledger: which ref, inside which plan version, became which task.
-- This is the ONLY record of how a ref resolved, and therefore the only way to answer
-- "which plan created this task" without guessing.
CREATE TABLE plan_task_outcomes (
  plan_id      TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  ref          TEXT NOT NULL,
  change       TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  PRIMARY KEY (plan_id, plan_version, ref),
  FOREIGN KEY (plan_id, plan_version) REFERENCES plans(id, version) ON DELETE CASCADE
);

CREATE INDEX plan_task_outcomes_by_task ON plan_task_outcomes(task_id);
`;
const MIGRATION_6 = `
-- Required results and completion criteria live on the TASK VERSION, because they are part
-- of the definition: changing them is a definition change and must produce a new version.
-- Both are display-only free text. The system cannot judge whether a submitted file is the
-- document that was asked for, so completeness can only mean "something was submitted"
-- (ADR-0010). Storing them as a checklist would demand file-to-item matching, which is a
-- quality judgement MVP explicitly excludes.
ALTER TABLE task_versions ADD COLUMN required_results TEXT;
ALTER TABLE task_versions ADD COLUMN completion_criteria TEXT;

-- The proposal carries them too, since a plan is what defines them in the first place.
ALTER TABLE plan_tasks ADD COLUMN required_results TEXT;
ALTER TABLE plan_tasks ADD COLUMN completion_criteria TEXT;

-- Progress notes. Append-only; saving one never completes a task and drives nothing
-- downstream (MVP-024). Tied to the task VERSION being worked to, so progress written
-- against different requirements never mixes.
CREATE TABLE progress (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_version INTEGER NOT NULL,
  note         TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX progress_by_task ON progress(task_id, task_version, created_at);

-- A submission. explanation + files + self-check form ONE version, not three: completeness
-- is a property of "this version has what it needed", which presupposes they belong
-- together. Append-only -- a returned submission stays readable, because it is the basis
-- for the correction.
CREATE TABLE result_versions (
  result_id    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_version INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  self_check   TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (result_id, version)
);

CREATE INDEX result_versions_by_task ON result_versions(task_id, version);

-- Files attached to one result version. Bytes live in the material store; only the
-- reference and hash are recorded here.
CREATE TABLE result_files (
  result_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  position      INTEGER NOT NULL,
  rel_path      TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  PRIMARY KEY (result_id, version, position),
  FOREIGN KEY (result_id, version)
    REFERENCES result_versions(result_id, version) ON DELETE CASCADE
);

-- The owning role's review. One slot per result version, like a confirmation slot.
-- complete -> this is what puts completed_at on the task; return -> no completion record.
CREATE TABLE result_confirmations (
  result_id      TEXT NOT NULL,
  version        INTEGER NOT NULL,
  role           TEXT NOT NULL,
  outcome        TEXT,
  reason         TEXT,
  submitted_by   TEXT,
  decided_at     TEXT,
  PRIMARY KEY (result_id, version),
  FOREIGN KEY (result_id, version)
    REFERENCES result_versions(result_id, version) ON DELETE CASCADE
);

-- A downstream task's decision on ONE specific result version (MVP-027). Acceptance is an
-- independent decision: an upstream completion does NOT trigger it.
-- Rejecting records a reason and triggers nothing else -- it does not undo the upstream
-- completion, and it does not create a plan, task or issue.
CREATE TABLE acceptances (
  result_id    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  outcome      TEXT,
  reason       TEXT,
  submitted_by TEXT,
  decided_at   TEXT,
  PRIMARY KEY (result_id, version, task_id),
  FOREIGN KEY (result_id, version)
    REFERENCES result_versions(result_id, version) ON DELETE CASCADE
);

CREATE INDEX acceptances_by_task ON acceptances(task_id);
`;
const MIGRATION_7 = `
-- READ STATE, and nothing else.
--
-- Todos are NOT stored: they are derived from the undecided slots that already exist in
-- confirmations, result_confirmations and acceptances (ADR-0011). Storing a second copy
-- would immediately raise "the slot was voided by a revision, who deletes the todo?", which
-- has no cheap answer. Deriving cannot go out of sync.
--
-- Read state is the one thing that CANNOT be derived -- nothing else in the database
-- records who looked at what -- so it is the necessary exception.
--
-- Keyed by SLOT, not by person: MVP-030 requires reads to be recorded per role slot, which
-- matches the rest of the MVP, where a decision belongs to a role rather than a person.
-- When a role changes hands, what that role has read stays read.
--
-- The primary key is what makes "reading twice does not count twice" true: it is a
-- constraint, not counting logic.
CREATE TABLE reads (
  kind       TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  role       TEXT NOT NULL,
  task_id    TEXT NOT NULL DEFAULT '',
  read_at    TEXT NOT NULL,
  read_by    TEXT,
  PRIMARY KEY (kind, object_id, version, role, task_id)
);
`;
const MIGRATION_8 = `
-- WHICH INPUT VERSION A DOWNSTREAM TASK ACTUALLY CONSUMED.
--
-- M7 must answer "from a result, which input versions did it actually use" (MVP-031). That
-- was NOT answerable before this migration, and the gap was real rather than theoretical:
-- the probe showed an upstream task could publish v1 and v2, a downstream could accept v1,
-- and nothing anywhere recorded WHICH version the downstream had taken.
--
-- MVP-023 already required a task's required input to point at a SPECIFIC upstream result
-- version; only the task id was ever stored.
--
-- The version is pinned when the downstream ACCEPTS, because accepting already means "I am
-- using this one" (ADR-0012). That adds no new action and creates no second source of truth.
--
-- A REJECTION records the version too, with outcome 'reject'. That keeps "decided and
-- refused" distinguishable from "never decided at all", which traceability needs: the first
-- blocks completion, the second means the slot is still open.
--
-- NOTE: this column is on the acceptance rather than on result_versions because an input is
-- consumed by the DOWNSTREAM task, not by the upstream result. Putting it on the upstream
-- row would force one row to describe every downstream consumer at once.
ALTER TABLE acceptances ADD COLUMN accepted_task_version INTEGER;

-- The upstream task version the consumed result was produced from, denormalised so a chain
-- can be walked without re-deriving it. Written at the same moment as accepted_task_version.
ALTER TABLE acceptances ADD COLUMN accepted_result_task_version INTEGER;
`;
const MIGRATION_9 = `
-- WHO IS SPEAKING IN THIS SESSION.
--
-- MVP-019 requires a plan confirmation to be submitted by "该角色的成员" — the member of that
-- role. The implementation only ever checked that the SLOT had a member, never that the person
-- submitting WAS that member. The consequence showed up immediately in real use: an agent asked
-- to register a 9-role plan invented a name for every role (陈静, 林晓雯, ...), and all nine
-- confirmations were recordable by anyone. "Confirmed by that role's member" was, in effect,
-- not implemented at all.
--
-- The root cause was that ONE column, project_roles.member_label, was answering TWO different
-- questions:
--
--     who is speaking right now?      <- session-scoped, one person
--     who does this slot belong to?   <- project-scoped, one per role
--
-- They are allowed to disagree, and they MUST be allowed to, or the model becomes circular:
-- "I declare myself to be pm, therefore I am now pm's member" would legalise any self-appointed
-- identity. So the two are stored separately: this table answers only the first question, and
-- project_roles keeps answering only the second.
--
-- Keyed by session id (exec.agent.session.id), so a declaration covers every project the session
-- touches: being a person does not change when you switch projects.
--
-- member_label is deliberately NOT a foreign key to project_roles: it is a snapshot of a
-- declared name, exactly as member_label and submitted_by elsewhere. A later rename must not
-- rewrite what a past session declared (ADR-0010, ADR-0014).
CREATE TABLE session_members (
  session_id   TEXT PRIMARY KEY,
  member_label TEXT NOT NULL,
  declared_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`;
function applyMigrations(db, from) {
    db.exec('BEGIN IMMEDIATE');
    try {
        if (from < 1) {
            db.exec(MIGRATION_1);
            db.exec('PRAGMA user_version = 1');
        }
        if (from < 2) {
            db.exec(MIGRATION_2);
            db.exec('PRAGMA user_version = 2');
        }
        if (from < 3) {
            db.exec(MIGRATION_3);
            db.exec('PRAGMA user_version = 3');
        }
        if (from < 4) {
            db.exec(MIGRATION_4);
            db.exec('PRAGMA user_version = 4');
        }
        if (from < 5) {
            db.exec(MIGRATION_5);
            db.exec('PRAGMA user_version = 5');
        }
        if (from < 6) {
            db.exec(MIGRATION_6);
            db.exec('PRAGMA user_version = 6');
        }
        if (from < 7) {
            db.exec(MIGRATION_7);
            db.exec('PRAGMA user_version = 7');
        }
        if (from < 8) {
            db.exec(MIGRATION_8);
            db.exec('PRAGMA user_version = 8');
        }
        if (from < 9) {
            db.exec(MIGRATION_9);
            db.exec('PRAGMA user_version = 9');
        }
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
export function migrate(db) {
    const row = db.prepare('PRAGMA user_version').get();
    const current = row?.user_version ?? 0;
    if (current > SCHEMA_VERSION || current < 0) {
        throw new CollaborationError('STORAGE_SCHEMA_UNSUPPORTED', `collaboration schema ${current} is newer than this build supports (${SCHEMA_VERSION})`, { onDisk: current, supported: SCHEMA_VERSION });
    }
    if (current === SCHEMA_VERSION)
        return;
    applyMigrations(db, current);
}
/** Run `fn` inside a write transaction, rolling back on any throw. */
// Nesting depth per connection. SQLite has no nested BEGIN, so an inner call uses a
// SAVEPOINT instead. Without this, composing two transactional operations (e.g. "replace
// the plan version, then void its confirmations") would throw "cannot start a transaction
// within a transaction" — and the naive fix, having the inner one silently skip its
// transaction, would quietly destroy atomicity at exactly the point it matters.
const depth = new WeakMap();
export function inTransaction(db, fn) {
    const level = depth.get(db) ?? 0;
    const nested = level > 0;
    const name = `wb_sp_${level}`;
    db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    depth.set(db, level + 1);
    try {
        const result = fn();
        db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
    }
    catch (error) {
        try {
            // Rolling back to the savepoint (rather than releasing it) is what makes an inner
            // failure leave the outer transaction intact and usable.
            db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
            if (nested)
                db.exec(`RELEASE ${name}`);
        }
        catch {
            // A failed rollback must not mask the original error.
        }
        throw error;
    }
    finally {
        depth.set(db, level);
    }
}
