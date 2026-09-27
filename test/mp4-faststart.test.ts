import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ensureMp4Faststart,
  mp4FaststartFromHead,
  mp4IsFaststart,
  readMp4Boxes,
} from "../src/mp4-faststart.js";

/** A box: 4-byte size, 4-byte type, payload. */
function box(type: string, payload: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length, 0);
  h.write(type, 4, "latin1");
  return Buffer.concat([h, payload]);
}

/** An `stco` holding the given absolute chunk offsets. */
function stco(offsets: number[]): Buffer {
  const p = Buffer.alloc(8 + offsets.length * 4);
  p.writeUInt32BE(0, 0); // version + flags
  p.writeUInt32BE(offsets.length, 4);
  offsets.forEach((o, i) => p.writeUInt32BE(o, 8 + i * 4));
  return box("stco", p);
}

/** moov > trak > mdia > minf > stbl > stco — the real nesting. */
function moovWith(chunkOffsets: number[]): Buffer {
  return box("moov", box("trak", box("mdia", box("minf", box("stbl", stco(chunkOffsets))))));
}

/** A file with the media first and the index last — what a streaming muxer writes. */
function tailIndexFile(mediaBytes: number, media = 0xab) {
  const ftyp = box("ftyp", Buffer.from("M4A isom", "latin1"));
  const mdatPayload = Buffer.alloc(mediaBytes, media);
  const mdat = box("mdat", mdatPayload);
  // Chunks point at real positions inside mdat's payload.
  const mdatStart = ftyp.length;
  const payloadStart = mdatStart + 8;
  const offsets = [payloadStart, payloadStart + 16, payloadStart + 32];
  const moov = moovWith(offsets);
  return { file: Buffer.concat([ftyp, mdat, moov]), ftyp, mdat, moov, offsets, mdatPayload };
}

/** Read the chunk offsets back out of a file's moov. */
function readOffsets(file: Buffer): number[] {
  const boxes = readMp4Boxes(file)!;
  const moov = boxes.find((b) => b.type === "moov")!;
  const buf = file.subarray(moov.start, moov.start + moov.size);
  // `at` is where the TYPE starts, so the payload begins 4 bytes later:
  // [version+flags 4][entry_count 4][offsets...]
  const at = buf.indexOf(Buffer.from("stco", "latin1"));
  const count = buf.readUInt32BE(at + 8);
  return Array.from({ length: count }, (_, i) => buf.readUInt32BE(at + 12 + i * 4));
}

describe("mp4 faststart", () => {
  it("leaves a file whose moov is already first alone", () => {
    const { ftyp, mdat, moov } = tailIndexFile(64);
    const already = Buffer.concat([ftyp, moov, mdat]);
    assert.equal(mp4IsFaststart(already), true);
    const r = ensureMp4Faststart(already);
    assert.equal(r.status, "already-ok");
    assert.ok(r.buffer.equals(already), "the bytes must not be touched");
  });

  it("moves moov to the front without changing the file's size", () => {
    const { file } = tailIndexFile(128);
    assert.equal(mp4IsFaststart(file), false);
    const r = ensureMp4Faststart(file);
    assert.equal(r.status, "fixed");
    assert.equal(r.buffer.length, file.length);
    assert.equal(mp4IsFaststart(r.buffer), true);
    const order = readMp4Boxes(r.buffer)!.map((b) => b.type);
    assert.deepEqual(order, ["ftyp", "moov", "mdat"]);
  });

  it("rewrites the chunk offsets so they still land on the same audio", () => {
    // THE failure this guards: move moov and leave stco alone, and the file
    // loads, reports the right duration, and plays whatever now sits at the
    // old offsets. Every chunk must still point at the byte it pointed at.
    const { file, mdatPayload } = tailIndexFile(256, 0x7f);
    const before = readOffsets(file);
    const wasAt = before.map((o) => file[o]);

    const r = ensureMp4Faststart(file);
    const after = readOffsets(r.buffer);

    assert.notDeepEqual(after, before, "offsets had to move");
    assert.deepEqual(
      after.map((o) => r.buffer[o]),
      wasAt,
      "each chunk offset must still address the same byte",
    );
    // And the media itself is untouched.
    const boxes = readMp4Boxes(r.buffer)!;
    const mdat = boxes.find((b) => b.type === "mdat")!;
    assert.ok(r.buffer.subarray(mdat.start + 8, mdat.start + mdat.size).equals(mdatPayload));
  });

  it("shifts by exactly moov's size", () => {
    const { file, moov } = tailIndexFile(96);
    const before = readOffsets(file);
    const after = readOffsets(ensureMp4Faststart(file).buffer);
    assert.deepEqual(after, before.map((o) => o + moov.length));
  });

  it("refuses a file it cannot index rather than returning something broken", () => {
    const ftyp = box("ftyp", Buffer.from("M4A ", "latin1"));
    const mdat = box("mdat", Buffer.alloc(32));
    const noMoov = ensureMp4Faststart(Buffer.concat([ftyp, mdat]));
    assert.equal(noMoov.status, "failed");
    assert.match(noMoov.detail!, /no moov/);

    const notMp4 = ensureMp4Faststart(Buffer.from("this is not a box structure at all"));
    assert.equal(notMp4.status, "failed");
  });

  it("decides from a head, and says so when the head is too short", () => {
    const { file, ftyp } = tailIndexFile(4096);
    // Head reaching into mdat: media comes first, so it is not faststart.
    assert.equal(mp4FaststartFromHead(file.subarray(0, ftyp.length + 8)), false);
    // Head stopping inside ftyp: undecidable.
    assert.equal(mp4FaststartFromHead(file.subarray(0, 4)), null);
  });
});
