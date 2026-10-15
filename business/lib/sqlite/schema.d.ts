/**
 * Schema ownership and versioned migration.
 *
 * `PRAGMA user_version` is the schema version. A database newer than this build is
 * refused rather than guessed at — silently running against an unknown shape is how
 * data gets corrupted.
 */
import { DatabaseSync } from 'node:sqlite';
export declare const SCHEMA_VERSION = 10;
export declare function migrate(db: DatabaseSync): void;
export declare function inTransaction<T>(db: DatabaseSync, fn: () => T): T;
