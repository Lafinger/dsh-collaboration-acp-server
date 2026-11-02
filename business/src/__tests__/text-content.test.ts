import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeTextContent } from '../service/text-content.js'

describe('shared plain-text decoder', () => {
  const text = '<html>中文 😀\tline\r\npage\f</html>'

  test('strict UTF-8 with optional BOM preserves raw text and normal whitespace', () => {
    assert.equal(decodeTextContent(Buffer.from(text)), text)
    assert.equal(decodeTextContent(Buffer.from(`\ufeff${text}`)), text)
    assert.equal(decodeTextContent(new Uint8Array()), '')
  })

  test('UTF-16 LE and BE require BOM and preserve surrogate pairs', () => {
    const le = Buffer.from(`\ufeff${text}`, 'utf16le')
    assert.equal(decodeTextContent(le), text)
    assert.equal(decodeTextContent(Buffer.from(le).swap16()), text)
    // Honor byte offsets rather than decoding an entire underlying ArrayBuffer.
    const wrapped = Buffer.concat([Buffer.from([0]), le, Buffer.from([0])])
    assert.equal(decodeTextContent(wrapped.subarray(1, wrapped.length - 1)), text)
    assert.throws(() => decodeTextContent(Buffer.from('hello', 'utf16le')))
    assert.throws(() => decodeTextContent(Buffer.from('hello', 'utf16le').swap16()))
  })

  test('malformed UTF-8, legacy encodings, UTF-32 and malformed UTF-16 are refused, never guessed', () => {
    for (const bytes of [
      [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xff],
      [0xd6, 0xd0, 0xce, 0xc4], // GBK Chinese, not UTF-8.
      [0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00], // UTF-32 LE.
      [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61], // UTF-32 BE.
      [0xff, 0xfe, 0x61], [0xfe, 0xff, 0x00], // Odd byte count.
      [0xff, 0xfe, 0x00, 0xd8], [0xfe, 0xff, 0xdc, 0x00], // Lone surrogate.
    ]) assert.throws(() => decodeTextContent(Uint8Array.from(bytes)), /supported|UTF-8/)
  })

  test('NUL, other C0 controls, DEL and C1 are rejected even when validly encoded', () => {
    for (const code of [0, 1, 8, 11, 14, 31, 127, 128, 133, 159]) {
      for (const bytes of [Buffer.from(`a${String.fromCharCode(code)}b`), Buffer.from(`\ufeffa${String.fromCharCode(code)}b`, 'utf16le')]) {
        assert.throws(() => decodeTextContent(bytes), /control|Binary/)
      }
    }
  })

  test('large text is returned whole, including the tail', () => {
    const large = '中文'.repeat(160_000) + '\nEND-全文尾部'
    const decoded = decodeTextContent(Buffer.from(large))
    assert.equal(decoded.length, large.length)
    assert.equal(decoded, large)
    assert.ok(decoded.endsWith('END-全文尾部'))
  })
})
