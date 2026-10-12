export class ResultRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    // ---- progress -------------------------------------------------------------
    insertProgress(entry) {
        this.db
            .prepare(`INSERT INTO progress (id, task_id, task_version, note, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`)
            .run(entry.id, entry.taskId, entry.taskVersion, entry.note, entry.submittedBy, entry.createdAt);
    }
    progressOf(taskId) {
        return this.db
            .prepare('SELECT * FROM progress WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
            .all(taskId).map((r) => ({
            id: r.id,
            taskId: r.task_id,
            taskVersion: Number(r.task_version),
            note: r.note,
            submittedBy: r.submitted_by,
            createdAt: r.created_at,
        }));
    }
    // ---- results --------------------------------------------------------------
    /** Highest existing version for a task's result, or 0 when it has none. */
    latestResultVersion(taskId) {
        const row = this.db
            .prepare('SELECT MAX(version) AS v FROM result_versions WHERE task_id = ?')
            .get(taskId);
        return row?.v === null || row?.v === undefined ? 0 : Number(row.v);
    }
    insertResult(record) {
        this.db
            .prepare(`INSERT INTO result_versions
           (result_id, version, task_id, task_version, summary, self_check, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(record.resultId, record.version, record.taskId, record.taskVersion, record.summary, record.selfCheck, record.submittedBy, record.createdAt);
        const file = this.db.prepare(`INSERT INTO result_files (result_id, version, position, rel_path, original_name, sha256, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);
        record.files.forEach((f, i) => {
            file.run(record.resultId, record.version, i, f.relPath, f.originalName, f.sha256, f.sizeBytes);
        });
    }
    /** An open confirmation slot for a freshly submitted result. */
    createConfirmationSlot(resultId, version, role) {
        this.db
            .prepare(`INSERT INTO result_confirmations (result_id, version, role, outcome, reason, submitted_by, decided_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`)
            .run(resultId, version, role);
    }
    recordReview(resultId, version, outcome, reason, submittedBy, at) {
        this.db
            .prepare(`UPDATE result_confirmations
            SET outcome = ?, reason = ?, submitted_by = ?, decided_at = ?
          WHERE result_id = ? AND version = ?`)
            .run(outcome, reason, submittedBy, at, resultId, version);
    }
    confirmationOf(resultId, version) {
        const row = this.db
            .prepare('SELECT * FROM result_confirmations WHERE result_id = ? AND version = ?')
            .get(resultId, version);
        if (row === undefined)
            return null;
        return {
            id: `${row.result_id}:${row.version}`,
            resultId: row.result_id,
            resultVersion: Number(row.version),
            role: row.role,
            outcome: row.outcome ?? null,
            reason: row.reason,
            submittedBy: row.submitted_by,
            decidedAt: row.decided_at,
        };
    }
    findResultVersion(resultId, version) {
        const row = this.db
            .prepare('SELECT * FROM result_versions WHERE result_id = ? AND version = ?')
            .get(resultId, version);
        return row === undefined ? null : this.hydrate(row);
    }
    /**
     * Every result version of a task, oldest first.
     *
     * A returned submission is still here: it is the basis for the correction, so discarding
     * it would destroy the record of what was rejected.
     */
    resultsOf(taskId) {
        return this.db
            .prepare('SELECT * FROM result_versions WHERE task_id = ? ORDER BY version ASC')
            .all(taskId).map((r) => this.hydrate(r));
    }
    // ---- acceptance -----------------------------------------------------------
    createAcceptanceSlot(resultId, version, taskId) {
        this.db
            .prepare(`INSERT INTO acceptances (result_id, version, task_id, outcome, reason, submitted_by, decided_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`)
            .run(resultId, version, taskId);
    }
    recordAcceptance(resultId, version, taskId, outcome, reason, submittedBy, at,
    /**
     * The versions this decision pins down (ADR-0012). Recorded HERE, at decision time,
     * rather than when the slot opened: a revision in between would otherwise make the
     * record describe a definition that was never used.
     *
     * A REJECTION records them too, which keeps "refused" distinguishable from "never
     * decided" — traceability needs that difference.
     */
    acceptedTaskVersion, acceptedResultTaskVersion) {
        this.db
            .prepare(`UPDATE acceptances
            SET outcome = ?, reason = ?, submitted_by = ?, decided_at = ?,
                accepted_task_version = ?, accepted_result_task_version = ?
          WHERE result_id = ? AND version = ? AND task_id = ?`)
            .run(outcome, reason, submittedBy, at, acceptedTaskVersion, acceptedResultTaskVersion, resultId, version, taskId);
    }
    /**
     * The task that owns a result id, or null when no such result exists.
     *
     * A result id is minted per submission, so its owner is a lookup rather than something
     * encoded in the id.
     */
    ownerOf(resultId) {
        const row = this.db
            .prepare('SELECT task_id FROM result_versions WHERE result_id = ? LIMIT 1')
            .get(resultId);
        return row?.task_id ?? null;
    }
    acceptancesOf(resultId, version) {
        return this.hydrateAcceptances('SELECT * FROM acceptances WHERE result_id = ? AND version = ? ORDER BY task_id', [resultId, version]);
    }
    /** Every acceptance decision made BY a task, so a task can see what it decided. */
    acceptancesByTask(taskId) {
        return this.hydrateAcceptances('SELECT * FROM acceptances WHERE task_id = ? ORDER BY result_id, version', [taskId]);
    }
    /**
     * One hydrator, so the two acceptance readers cannot drift apart.
     *
     * They were separate copies until M7 added two columns; had they stayed separate, adding a
     * field to one and not the other would have produced two subtly different objects for the
     * same row.
     */
    hydrateAcceptances(sql, params) {
        return this.db.prepare(sql).all(...params).map((r) => ({
            id: `${r.result_id}:${r.version}:${r.task_id}`,
            resultId: r.result_id,
            resultVersion: Number(r.version),
            taskId: r.task_id,
            acceptedTaskVersion: r.accepted_task_version === null ? null : Number(r.accepted_task_version),
            acceptedResultTaskVersion: r.accepted_result_task_version === null ? null : Number(r.accepted_result_task_version),
            outcome: r.outcome ?? null,
            reason: r.reason,
            submittedBy: r.submitted_by,
            decidedAt: r.decided_at,
        }));
    }
    hydrate(row) {
        return {
            resultId: row.result_id,
            version: Number(row.version),
            taskId: row.task_id,
            taskVersion: Number(row.task_version),
            summary: row.summary,
            selfCheck: row.self_check,
            files: this.filesOf(row.result_id, Number(row.version)),
            submittedBy: row.submitted_by,
            createdAt: row.created_at,
        };
    }
    filesOf(resultId, version) {
        return this.db
            .prepare('SELECT * FROM result_files WHERE result_id = ? AND version = ? ORDER BY position')
            .all(resultId, version).map((r) => ({
            relPath: r.rel_path,
            originalName: r.original_name,
            sha256: r.sha256,
            sizeBytes: Number(r.size_bytes),
        }));
    }
}
