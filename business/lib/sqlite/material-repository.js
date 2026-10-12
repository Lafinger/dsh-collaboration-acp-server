function toMaterial(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        originalName: row.original_name,
        purpose: row.purpose,
        submittedBy: row.submitted_by,
        role: row.role ?? null,
        createdAt: row.created_at,
    };
}
function toVersion(row) {
    return {
        materialId: row.material_id,
        version: Number(row.version),
        relPath: row.rel_path,
        size: Number(row.size),
        sha256: row.sha256,
        issue: row.issue,
        createdAt: row.created_at,
    };
}
export class MaterialRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    insertMaterial(material) {
        this.db
            .prepare(`INSERT INTO materials (id, project_id, original_name, purpose, submitted_by, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(material.id, material.projectId, material.originalName, material.purpose, material.submittedBy, material.role, material.createdAt);
    }
    findById(id) {
        const row = this.db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
        return row === undefined ? null : toMaterial(row);
    }
    /** Identity is (project, original name, purpose) — so a new purpose starts a new material. */
    findByIdentity(projectId, originalName, purpose) {
        const row = this.db
            .prepare('SELECT * FROM materials WHERE project_id = ? AND original_name = ? AND purpose = ?')
            .get(projectId, originalName, purpose);
        return row === undefined ? null : toMaterial(row);
    }
    listByProject(projectId) {
        const rows = this.db
            .prepare('SELECT * FROM materials WHERE project_id = ? ORDER BY created_at DESC, id DESC')
            .all(projectId);
        return rows.map(toMaterial);
    }
    /** Highest existing version for a material, or 0 when it has none yet. */
    latestVersion(materialId) {
        const row = this.db
            .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM material_versions WHERE material_id = ?')
            .get(materialId);
        return Number(row.v);
    }
    insertVersion(version) {
        this.db
            .prepare(`INSERT INTO material_versions (material_id, version, rel_path, size, sha256, issue, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(version.materialId, version.version, version.relPath, version.size, version.sha256, version.issue, version.createdAt);
    }
    versionsOf(materialId) {
        const rows = this.db
            .prepare('SELECT * FROM material_versions WHERE material_id = ? ORDER BY version ASC')
            .all(materialId);
        return rows.map(toVersion);
    }
    findVersion(materialId, version) {
        const row = this.db
            .prepare('SELECT * FROM material_versions WHERE material_id = ? AND version = ?')
            .get(materialId, version);
        return row === undefined ? null : toVersion(row);
    }
    /** Count of version rows per material, used to detect unexpected gaps. */
    countVersions(materialId) {
        const row = this.db
            .prepare('SELECT COUNT(*) AS c FROM material_versions WHERE material_id = ?')
            .get(materialId);
        return Number(row.c);
    }
}
