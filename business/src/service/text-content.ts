/**
 * Decode plain text by its bytes, never by a filename, MIME type or charset hint.
 * Only strict UTF-8 (with or without BOM) and BOM-marked UTF-16 LE/BE are supported.
 * There is deliberately no content-size limit and no encoding fallback.
 */
export function decodeTextContent(bytes: Uint8Array): string {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'

  let content: string
  try {
    // TextDecoder consumes the leading BOM and rejects malformed sequences/surrogates.
    content = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Not text in a supported encoding (strict UTF-8 or BOM-marked UTF-16 LE/BE); save as UTF-8')
  }

  // Allow TAB, LF, CR and form feed (page breaks). Reject NUL, other C0 controls,
  // DEL and C1 controls: valid Unicode decoding alone does not establish plain text.
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/u.test(content)) {
    throw new Error('Binary or non-text control characters are not supported as plain text; save as UTF-8 text without NUL or non-text controls')
  }
  return content
}
