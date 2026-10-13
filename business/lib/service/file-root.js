/**
 * Storage path resolution and the fileRoot escape guard (ADR-0004).
 *
 * `path.join` does NOT prevent traversal — it preserves `..` verbatim. Worse,
 * `path.relative` does not complain when the target lies outside the root: it silently
 * returns a `..\..\`-prefixed path. So a naive "check the relative path afterwards" is
 * both too late (the write already happened) and easy to get wrong.
 *
 * Therefore: resolve FIRST, assert containment, and only then touch the filesystem.
 * Verified by a real write outside fileRoot before this guard existed.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CollaborationError } from '../domain/error.js';
/** Normalise to forward slashes so stored paths are portable across platforms. */
export function toPosixPath(path) {
    return path.split(sep).join('/');
}
export class FileRoot {
    root;
    constructor(root) {
        this.root = resolve(root);
    }
    /**
     * Is this absolute path inside the root?
     *
     * Extracted as its own method so it can be tested DIRECTLY. It matters: `resolve()`
     * rejects hostile segments first via `assertSafeSegment`, which makes this second guard
     * unreachable through `resolve()` alone — and an unreachable guard is an untested one.
     * A mutation that disabled this check once left the whole suite green, which is what
     * prompted pulling it out.
     */
    contains(absolutePath) {
        const rel = relative(this.root, resolve(absolutePath));
        if (rel === '')
            return true;
        return !rel.startsWith('..') && !isAbsolute(rel);
    }
    /**
     * Resolve path segments under the root, refusing anything that escapes.
     *
     * Every caller-supplied component (project id, role, filename) must be passed through
     * here. Validating only the source path is not enough: the escape comes from the
     * OUTPUT path components.
     */
    resolve(...segments) {
        for (const segment of segments) {
            assertSafeSegment(segment);
        }
        const target = resolve(this.root, ...segments);
        if (!this.contains(target)) {
            throw new CollaborationError('PATH_ESCAPES_FILE_ROOT', `refusing to write outside the storage root: ${segments.join('/')}`, { segments: [...segments] });
        }
        return target;
    }
    /** Path relative to the root, using `/` separators. Throws if it escapes. */
    relativeOf(absolutePath) {
        const rel = relative(this.root, resolve(absolutePath));
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            throw new CollaborationError('PATH_ESCAPES_FILE_ROOT', 'path is not inside the storage root', { path: absolutePath });
        }
        return toPosixPath(rel);
    }
}
/**
 * A single path segment must not contain separators, drive letters, or traversal.
 *
 * This is defence in depth: `FileRoot.resolve` already catches escapes, but rejecting a
 * hostile segment outright gives a clearer error and keeps the layout unambiguous.
 */
export function assertSafeSegment(segment) {
    if (segment === '' || segment === '.' || segment === '..') {
        throw new CollaborationError('INVALID_ARGUMENT', `unsafe path segment: "${segment}"`, { segment });
    }
    if (segment.includes('/') || segment.includes('\\')) {
        throw new CollaborationError('INVALID_ARGUMENT', `path segment must not contain separators: "${segment}"`, {
            segment,
        });
    }
    if (segment.includes('\0')) {
        throw new CollaborationError('INVALID_ARGUMENT', 'path segment must not contain NUL', { segment });
    }
    if (/^[a-zA-Z]:/.test(segment)) {
        throw new CollaborationError('INVALID_ARGUMENT', `path segment must not be a drive path: "${segment}"`, {
            segment,
        });
    }
}
/**
 * Build the version file name: `v<version>__<original name>`.
 *
 * The version is in the NAME, not a directory, and directories are ID-based — so an
 * awkward original filename (spaces, brackets, unicode) cannot break the layout or
 * collide with another version.
 */
export function versionFileName(version, originalName) {
    if (!Number.isInteger(version) || version < 1) {
        throw new CollaborationError('INVALID_ARGUMENT', `invalid version number: ${version}`, { version });
    }
    const safe = originalName.replace(/[\\/]/g, '_').replace(/\0/g, '');
    const trimmed = safe.trim() === '' ? 'unnamed' : safe;
    return `v${version}__${trimmed}`;
}
