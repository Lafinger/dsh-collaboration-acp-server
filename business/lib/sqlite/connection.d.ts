import { DatabaseSync } from 'node:sqlite';
export interface OpenOptions {
    /** Path to the database file, or ':memory:' for tests. */
    readonly path: string;
}
export declare function openDatabase(options: OpenOptions): DatabaseSync;
