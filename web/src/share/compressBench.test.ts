// One-off compression-ratio bench. Run with `npm test`; outputs to stderr.
// Not an assertion test — purely informational. Kept under the existing test
// glob so it runs alongside the unit tests.
import { describe, it } from "vitest";
import { bytesToBase64Url, compressIr } from "./irCompress";

function rawB64(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s));
}

async function deflateOnly(s: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(s) as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToBase64Url(bytes);
}

async function bench(name: string, s: string) {
  const raw = rawB64(s);
  const plain = await deflateOnly(s);
  const dict = await compressIr(s);
  const rawLen = raw.length;
  // eslint-disable-next-line no-console
  console.log(
    [
      ``,
      `=== ${name} — ${s.length} src chars ===`,
      `  raw base64url:         ${rawLen} chars`,
      `  deflate-only + b64:    ${plain.length} chars  (${((plain.length / rawLen) * 100).toFixed(1)}% of raw)`,
      `  irz (dict + deflate):  ${dict.length} chars  (${((dict.length / rawLen) * 100).toFixed(1)}% of raw, ${((dict.length / plain.length) * 100).toFixed(1)}% of deflate-only)`,
    ].join("\n"),
  );
}

const TYPICAL_IR = `; ModuleID = 'foo.c'
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
  ret i32 %add_result
}

define dso_local i32 @main(i32 noundef %argc, ptr noundef %argv) #0 {
entry:
  %retval = alloca i32, align 4
  %argc.addr = alloca i32, align 4
  %argv.addr = alloca ptr, align 8
  store i32 0, ptr %retval, align 4
  store i32 %argc, ptr %argc.addr, align 4
  store ptr %argv, ptr %argv.addr, align 8
  %call = call i32 @add(i32 noundef 1, i32 noundef 2)
  ret i32 %call
}

attributes #0 = { noinline nounwind optnone uwtable "frame-pointer"="all" }
`;

function makeLarge(): string {
  const header = "define dso_local i32 @big(i32 noundef %x, ptr noundef %p) {\nentry:\n";
  let body = "";
  for (let i = 0; i < 500; i++) {
    body += `  %a${i} = add nsw i32 %x, ${i}\n`;
    body += `  %b${i} = getelementptr inbounds i32, ptr %p, i64 ${i}\n`;
    body += `  store i32 %a${i}, ptr %b${i}, align 4\n`;
    body += `  %c${i} = load i32, ptr %b${i}, align 4\n`;
    body += `  %d${i} = icmp slt i32 %c${i}, ${i * 7}\n`;
  }
  return header + body + "  ret i32 %x\n}\n";
}

describe.skip("compression bench (informational)", () => {
  it("DEFAULT_IR", async () => {
    await bench(
      "DEFAULT_IR (5 lines)",
      `; paste LLVM IR here, then press Run.\ndefine i32 @f(i32 %x) {\n  %a = add i32 %x, 0\n  ret i32 %a\n}\n`,
    );
  });
  it("typical clang -O0 output", async () => {
    await bench("Typical clang -O0 output (~30 lines)", TYPICAL_IR);
  });
  it("large synthetic IR", async () => {
    await bench("Large synthetic IR (500 iters × 5 ops)", makeLarge());
  });
});
