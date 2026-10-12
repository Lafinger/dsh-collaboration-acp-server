/** 32-char lowercase hex, no dashes. Safe as a single path segment on every platform. */
export declare function newId(): string;
export declare function isId(value: unknown): value is string;
/**
 * Material/result ids are small integers in the on-disk layout (`materials/<n>`), so they
 * are allocated by the storage layer inside the same transaction as the insert.
 */
export type SequenceId = number;
