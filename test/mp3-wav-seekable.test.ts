import assert from "node:assert/strict";
import { test } from "node:test";

import { hasSeekIndex } from "../src/ensure-seekable.js";
import { mp3HasSeekInfo, readMp3Layout } from "../src/mp3-seekable.js";
import { ensureWavSeekable, readWavLayout, wavHeaderIsSound } from "../src/wav-seekable.js";

/** An MPEG-1 Layer III stereo frame header (128 kbps, 44.1 kHz) + side info. */
function mp3Frame(withInfo: boolean, flags = 0x0f): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const side = Buffer.alloc(32);
  const body = Buffer.alloc(417 - 36);
  if (withInfo) {
    body.write("Info", 0, "latin1");
    body.writeUInt32BE(flags, 4);
  }
  return Buffer.concat([header, side, body]);
}

/** An ID3v2.3 tag holding one APIC frame of `art` bytes. */
function id3(art: number): Buffer {
  const frame = Buffer.concat([Buffer.from("APIC", "latin1"), Buffer.alloc(6), Buffer.alloc(art)]);
  frame.writeUInt32BE(art, 4);
  const size = frame.length;
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([head, frame]);
}

test("mp3: layout reads the ID3 tag, artwork and the Info frame", () => {
  const withInfo = Buffer.concat([id3(5000), mp3Frame(true), mp3Frame(false)]);
  const l = readMp3Layout(withInfo);
  assert.ok(l);
  assert.equal(l.id3Bytes, 10 + 10 + 5000);
  assert.equal(l.artworkBytes, 5000);
  assert.equal(l.firstFrame, l.id3Bytes);
  assert.deepEqual(l.xing, { kind: "Info", frames: true, bytes: true, toc: true });
  assert.equal(mp3HasSeekInfo(withInfo), true);

  const noInfo = Buffer.concat([mp3Frame(false), mp3Frame(false)]);
  assert.equal(readMp3Layout(noInfo)?.xing, null);
  assert.equal(mp3HasSeekInfo(noInfo), false);
  // An Info frame without a TOC is not enough to seek by.
  const noToc = Buffer.concat([mp3Frame(true, 0x03)]);
  assert.equal(mp3HasSeekInfo(noToc), false);
});

test("mp3: a head that ends inside a big cover image cannot decide", () => {
  const big = Buffer.concat([id3(200_000), mp3Frame(true)]);
  assert.equal(mp3HasSeekInfo(big.subarray(0, 16 * 1024)), null);
  assert.equal(hasSeekIndex(big.subarray(0, 16 * 1024), "x.mp3"), null);
  assert.equal(hasSeekIndex(big, "x.mp3"), true);
});

/** A 16-bit PCM WAV of `frames` stereo frames, with the sizes the header claims. */
function wav(frames: number, opts: { riffSize?: number; dataSize?: number; format?: number; bits?: number } = {}): Buffer {
  const bits = opts.bits ?? 16;
  const channels = 2;
  const data = Buffer.alloc(frames * channels * (bits / 8));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(opts.riffSize ?? 36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(opts.format ?? 1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(16000 * channels * (bits / 8), 28);
  h.writeUInt16LE(channels * (bits / 8), 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(opts.dataSize ?? data.length, 40);
  return Buffer.concat([h, data]);
}

test("wav: a clean 16-bit PCM file is left alone", () => {
  const b = wav(1000);
  assert.equal(ensureWavSeekable(b).status, "already-ok");
  assert.equal(wavHeaderIsSound(b.subarray(0, 64), b.length), true);
  assert.equal(hasSeekIndex(b.subarray(0, 64), "x.wav", b.length), true);
  // Without the total size the head alone cannot judge a WAV.
  assert.equal(hasSeekIndex(b.subarray(0, 64), "x.wav"), null);
});

test("wav: streaming-writer sizes (0 / 0xFFFFFFFF) are rewritten in place, audio untouched", () => {
  const b = wav(1000, { riffSize: 0, dataSize: 0xffffffff });
  assert.equal(wavHeaderIsSound(b.subarray(0, 64), b.length), false);
  const r = ensureWavSeekable(b);
  assert.equal(r.status, "fixed");
  const l = readWavLayout(r.buffer)!;
  assert.equal(l.dataSize, 4000);
  assert.equal(l.riffSize, r.buffer.length - 8);
  assert.ok(r.buffer.subarray(44).equals(b.subarray(44)));
  // A truncated trailing sample is dropped so the data stays frame-aligned.
  const odd = Buffer.concat([wav(1000, { dataSize: 0 }), Buffer.alloc(3)]);
  assert.equal(readWavLayout(ensureWavSeekable(odd).buffer)!.dataSize, 4000);
});

test("wav: non-16-bit-PCM streams are reported for transcoding", () => {
  assert.equal(readWavLayout(wav(10, { format: 3, bits: 32 }))!.formatTag, 3);
  assert.equal(readWavLayout(wav(10, { bits: 24 }))!.bitsPerSample, 24);
  assert.equal(wavHeaderIsSound(wav(10, { bits: 24 }), wav(10, { bits: 24 }).length), false);
});
