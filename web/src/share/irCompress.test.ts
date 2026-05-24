import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  compressIr,
  decompressIr,
  isCompressionSupported,
  restoreTokens,
  substituteTokens,
} from "./irCompress";
import { DICTIONARY, DICT_MAX_ENTRIES } from "./irDictionary";

const DEFAULT_IR = `; paste LLVM IR here, then press Run.
define i32 @f(i32 %x) {
  %a = add i32 %x, 0
  ret i32 %a
}
`;

const LARGER_IR = `; ModuleID = 'foo.c'
source_filename = "foo.c"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-gnu"

define dso_local i32 @add(i32 noundef %a, i32 noundef %b) #0 {
entry:
  %a.addr = alloca i32, align 4
  %b.addr = alloca i32, align 4
  store i32 %a, ptr %a.addr, align 4
  store i32 %b, ptr %b.addr, align 4
  %0 = load i32, ptr %a.addr, align 4
  %1 = load i32, ptr %b.addr, align 4
  %add_result = add nsw i32 %0, %1
  %p = getelementptr inbounds i32, ptr %a.addr, i64 1
  %cmp = icmp slt i32 %add_result, 100
  br i1 %cmp, label %then, label %else, !dbg !12

then:
  ret i32 %add_result

else:
  %cast = addrspacecast ptr addrspace(0) %a.addr to ptr addrspace(1)
  ret i32 0
}
`;

function makeLargeIr(): string {
  const header = "define dso_local i32 @big(i32 noundef %x) {\nentry:\n";
  const footer = "  ret i32 %x\n}\n";
  let body = "";
  for (let i = 0; i < 200; i++) {
    body += `  %v${i} = add nsw i32 %x, ${i}\n`;
    body += `  %w${i} = getelementptr inbounds i32, ptr %x.addr, i64 ${i}\n`;
  }
  return header + body + footer;
}

function base64UrlOfUtf8(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s));
}

describe("compressIr / decompressIr round-trip", () => {
  it("environment supports CompressionStream", () => {
    expect(isCompressionSupported()).toBe(true);
  });

  it("round-trips DEFAULT_IR", async () => {
    const out = await decompressIr(await compressIr(DEFAULT_IR));
    expect(out).toBe(DEFAULT_IR);
  });

  it("round-trips empty string", async () => {
    expect(await decompressIr(await compressIr(""))).toBe("");
  });

  it("round-trips a single newline", async () => {
    expect(await decompressIr(await compressIr("\n"))).toBe("\n");
  });

  it("round-trips a larger IR with word-boundary-sensitive content", async () => {
    expect(await decompressIr(await compressIr(LARGER_IR))).toBe(LARGER_IR);
  });

  it("round-trips non-ASCII IR via the passthrough version", async () => {
    const s = "; comment with é and 中\ndefine i32 @f() { ret i32 0 }\n";
    const compressed = await compressIr(s);
    // First payload byte after base64url-decode must be 0x02 (passthrough).
    const framed = base64UrlToBytes(compressed);
    expect(framed[0]).toBe(0x02);
    expect(await decompressIr(compressed)).toBe(s);
  });

  it("ascii input uses the dictionary version byte", async () => {
    const framed = base64UrlToBytes(await compressIr(DEFAULT_IR));
    expect(framed[0]).toBe(0x01);
  });
});

describe("compression effectiveness", () => {
  it("compresses a ~5KB repetitive IR to under half of raw base64url", async () => {
    const big = makeLargeIr();
    const compressedB64 = await compressIr(big);
    const rawB64 = base64UrlOfUtf8(big);
    expect(compressedB64.length).toBeLessThan(rawB64.length * 0.5);
  });
});

describe("word-boundary correctness", () => {
  it("does not collapse 'add' inside addrspacecast or %add_result", () => {
    const input = "addrspacecast %add_result, ptr";
    const bytes = substituteTokens(input);
    // Find the dict byteCode for the bare-word 'add' entry.
    const addIdx = DICTIONARY.findIndex(
      (e) => e.token === "add" && e.wordBoundary === true,
    );
    expect(addIdx).toBeGreaterThanOrEqual(0);
    const addByte = 0x80 + addIdx;
    // The substituted stream must not contain that byte at any position,
    // because 'add' only appears here as a prefix of longer identifiers.
    for (let i = 0; i < bytes.length; i++) {
      expect(bytes[i]).not.toBe(addByte);
    }
    // And round-trip must be exact.
    expect(restoreTokens(bytes)).toBe(input);
  });

  it("does substitute 'add' as a bare word with surrounding spaces", () => {
    const input = "  %x = add i32 %y, 1\n";
    const bytes = substituteTokens(input);
    const addIdx = DICTIONARY.findIndex(
      (e) => e.token === "add" && e.wordBoundary === true,
    );
    const addByte = 0x80 + addIdx;
    expect(Array.from(bytes)).toContain(addByte);
    expect(restoreTokens(bytes)).toBe(input);
  });
});

describe("decode error handling", () => {
  it("rejects an unknown version byte", async () => {
    const framed = new Uint8Array([0xee, 0x03, 0x00]); // bogus version + minimal raw deflate stored block (empty)
    // Build a real empty-deflate payload for byte safety, then override version.
    const real = base64UrlToBytes(await compressIr(""));
    framed.set(real.subarray(1), 1);
    const bogus = bytesToBase64Url(framed);
    await expect(decompressIr(bogus)).rejects.toThrow();
  });

  it("rejects invalid base64url", async () => {
    await expect(decompressIr("!!!not-base64!!!")).rejects.toThrow();
  });

  it("rejects a truncated deflate stream", async () => {
    const good = await compressIr(LARGER_IR);
    const truncated = good.slice(0, Math.max(0, good.length - 8));
    await expect(decompressIr(truncated)).rejects.toThrow();
  });

  it("rejects a 0xFF byte in the inflated stream", async () => {
    // Build framed = [0x01, ...deflate([0xFF, 0x41])] manually.
    const blob = new Blob([new Uint8Array([0xff, 0x41]) as BlobPart]);
    const piped = blob.stream().pipeThrough(new CompressionStream("deflate-raw"));
    const deflated = new Uint8Array(await new Response(piped).arrayBuffer());
    const framed = new Uint8Array(1 + deflated.length);
    framed[0] = 0x01;
    framed.set(deflated, 1);
    await expect(decompressIr(bytesToBase64Url(framed))).rejects.toThrow();
  });
});

describe("dictionary invariants", () => {
  it("does not exceed the byte-code cap", () => {
    expect(DICTIONARY.length).toBeLessThanOrEqual(DICT_MAX_ENTRIES);
  });

  it("all word-bounded entries are made of word chars only", () => {
    for (const entry of DICTIONARY) {
      if (entry.wordBoundary) {
        expect(entry.token).toMatch(/^[A-Za-z0-9_]+$/);
      }
    }
  });

  it("has no duplicate tokens", () => {
    const seen = new Set<string>();
    for (const entry of DICTIONARY) {
      expect(seen.has(entry.token)).toBe(false);
      seen.add(entry.token);
    }
  });
});
