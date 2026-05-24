// IR-aware compression for share URLs.
//
// Pipeline (encode):
//   ir string
//     → substituteTokens (static dictionary, 1 byte per matched LLVM keyword)
//     → DEFLATE-raw (browser-native CompressionStream)
//     → prefix 1 version byte
//     → base64url
//
// Wire format inside ?irz=, after base64url-decoding:
//   byte 0          version (0x01 ascii-dict, 0x02 non-ascii passthrough)
//   byte 1..        raw DEFLATE stream
//
// Two versions cover non-ASCII safely: LLVM IR text is normally pure ASCII,
// but comments and string literals can carry UTF-8 multi-byte chars whose
// bytes overlap the dictionary index range. The encoder pre-scans and picks
// 0x02 for non-ASCII inputs, in which case the deflate input is the raw
// UTF-8 byte sequence with no token substitution.

import { DICTIONARY, type DictEntry } from "./irDictionary";

const VERSION_ASCII_DICT = 0x01;
const VERSION_PASSTHROUGH = 0x02;
const DICT_BYTE_BASE = 0x80;
const RESERVED_ESCAPE = 0xff;

// Indexed by the first char of each entry for fast longest-match lookup.
// Each bucket is sorted by descending token length so the first match wins.
interface IndexedEntry extends DictEntry {
  byteCode: number;
}
const entriesByFirstChar: Map<string, IndexedEntry[]> = (() => {
  const m = new Map<string, IndexedEntry[]>();
  DICTIONARY.forEach((entry, i) => {
    if (entry.token.length === 0) {
      throw new Error(`dictionary entry ${i} is empty`);
    }
    const code = DICT_BYTE_BASE + i;
    if (code >= RESERVED_ESCAPE) {
      throw new Error(`dictionary entry ${i} byte 0x${code.toString(16)} collides with reserved escape`);
    }
    const head = entry.token[0];
    let bucket = m.get(head);
    if (!bucket) {
      bucket = [];
      m.set(head, bucket);
    }
    bucket.push({ ...entry, byteCode: code });
  });
  for (const bucket of m.values()) {
    bucket.sort((a, b) => b.token.length - a.token.length);
  }
  return m;
})();

function isWordChar(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    c === 0x5f // _
  );
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

// Exported for unit tests; encodes an ASCII string into the pre-deflate byte
// stream by substituting dictionary tokens. Caller must guarantee `s` is ASCII.
export function substituteTokens(s: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const head = s[i];
    const bucket = entriesByFirstChar.get(head);
    let matched: IndexedEntry | null = null;
    if (bucket) {
      for (const entry of bucket) {
        const tok = entry.token;
        const end = i + tok.length;
        if (end > n) continue;
        // Cheap string slice compare — V8 optimises this well for short tok.
        let ok = true;
        for (let k = 0; k < tok.length; k++) {
          if (s.charCodeAt(i + k) !== tok.charCodeAt(k)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (entry.wordBoundary) {
          const before = i > 0 ? s[i - 1] : "";
          const after = end < n ? s[end] : "";
          if (isWordChar(before) || isWordChar(after)) continue;
        }
        matched = entry;
        break;
      }
    }
    if (matched) {
      out.push(matched.byteCode);
      i += matched.token.length;
    } else {
      const c = s.charCodeAt(i);
      // Caller guarantees ASCII; defensive guard anyway.
      if (c > 0x7f) {
        throw new Error(`non-ASCII byte 0x${c.toString(16)} at offset ${i} in substituteTokens`);
      }
      out.push(c);
      i++;
    }
  }
  return new Uint8Array(out);
}

// Exported for unit tests; reverses substituteTokens. Throws on byte 0xFF.
export function restoreTokens(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === RESERVED_ESCAPE) {
      throw new Error(`unexpected reserved byte 0xFF at offset ${i}`);
    }
    if (b >= DICT_BYTE_BASE) {
      const idx = b - DICT_BYTE_BASE;
      if (idx >= DICTIONARY.length) {
        throw new Error(`dictionary index ${idx} out of range`);
      }
      out += DICTIONARY[idx].token;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("invalid base64url payload");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(padding);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isCompressionSupported(): boolean {
  return (
    typeof CompressionStream === "function" &&
    typeof DecompressionStream === "function"
  );
}

// Wrap the input bytes in a Blob so its `.stream()` produces a stream whose
// chunk type matches what CompressionStream / DecompressionStream expect. The
// alternative (constructing a `new ReadableStream<Uint8Array>` directly) trips
// up TS 5.7's stricter typed-array variance because Uint8Array<ArrayBufferLike>
// is not assignable to Uint8Array<ArrayBuffer>.
async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const piped = new Blob([input as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const piped = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function compressIr(s: string): Promise<string> {
  let version: number;
  let preDeflate: Uint8Array;
  if (isAscii(s)) {
    version = VERSION_ASCII_DICT;
    preDeflate = substituteTokens(s);
  } else {
    version = VERSION_PASSTHROUGH;
    preDeflate = new TextEncoder().encode(s);
  }
  const deflated = await deflateRaw(preDeflate);
  const framed = new Uint8Array(1 + deflated.length);
  framed[0] = version;
  framed.set(deflated, 1);
  return bytesToBase64Url(framed);
}

export async function decompressIr(s: string): Promise<string> {
  const framed = base64UrlToBytes(s);
  if (framed.length < 1) throw new Error("payload missing version byte");
  const version = framed[0];
  const body = framed.subarray(1);
  const inflated = await inflateRaw(body);
  if (version === VERSION_ASCII_DICT) {
    return restoreTokens(inflated);
  }
  if (version === VERSION_PASSTHROUGH) {
    return new TextDecoder("utf-8", { fatal: true }).decode(inflated);
  }
  throw new Error(`unknown irz version byte 0x${version.toString(16)}`);
}
