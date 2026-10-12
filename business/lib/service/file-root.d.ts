/** Normalise to forward slashes so stored paths are portable across platforms. */
export declare function toPosixPath(path: string): string;
export declare class FileRoot {
    readonly root: string;
    constructor(root: string);
    /**
     * Is this absolute path inside the root?
     *
     * Extracted as its own method so it can be tested DIRECTLY. It matters: `resolve()`
     * rejects hostile segments first via `assertSafeSegment`, which makes this second guard
     * unreachable through `resolve()` alone — and an unreachable guard is an untested one.
     * A mutation that disabled this check once left the whole suite green, which is what
     * prompted pulling it out.
     */
    contains(absolutePath: string): boolean;
    /**
     * Resolve path segments under the root, refusing anything that escapes.
     *
     * Every caller-supplied component (project id, role, filename) must be passed through
     * here. Validating only the source path is not enough: the escape comes from the
     * OUTPUT path components.
     */
    resolve(...segments: readonly string[]): string;
    /** Path relative to the root, using `/` separators. Throws if it escapes. */
    relativeOf(absolutePath: string): string;
}
/**
 * A single path segment must not contain separators, drive letters, or traversal.
 *
 * This is defence in depth: `FileRoot.resolve` already catches escapes, but rejecting a
 * hostile segment outright gives a clearer error and keeps the layout unambiguous.
 */
export declare function assertSafeSegment(segment: string): void;
/**
 * Build the version file name: `v<version>__<original name>`.
 *
 * The version is in the NAME, not a directory, and directories are ID-based — so an
 * awkward original filename (spaces, brackets, unicode) cannot break the layout or
 * collide with another version.
 */
export declare function versionFileName(version: number, originalName: string): string;
