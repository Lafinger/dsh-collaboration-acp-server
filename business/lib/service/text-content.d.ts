/**
 * Decode plain text by its bytes, never by a filename, MIME type or charset hint.
 * Only strict UTF-8 (with or without BOM) and BOM-marked UTF-16 LE/BE are supported.
 * There is deliberately no content-size limit and no encoding fallback.
 */
export declare function decodeTextContent(bytes: Uint8Array): string;
