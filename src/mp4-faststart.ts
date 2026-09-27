/**
 * MP4 / M4A "faststart": move `moov` in front of the media so a player can
 * seek without fetching the whole file.
 *
 * An MP4 muxer that does not know the final duration up front writes the media
 * first and the index (`moov`) last, because `moov` cannot be sized until the
 * samples are written. A player then cannot start — let alone seek — until it
 * has the tail, which over HTTP means downloading everything. Moving `moov` to
 * the front is the whole fix, and it is a byte move: no re-encode.
 *
 * THE PART THAT IS EASY TO GET WRONG. `moov` holds absolute file offsets to
 * every chunk of media (`stco`, or `co64` for files past 4 GiB). Move `moov`
 * and those offsets are all wrong — the file loads, reports the right duration,
 * and plays silence or noise. So every offset that pointed PAST the old `moov`
 * position is left alone, and every offset that pointed BEFORE it is advanced
 * by the size of the block that moved in ahead of it.
 *
 * Pure JavaScript. No ffmpeg, no temp files, samples never touched.
 */
import type { SeekableResult } from "./ensure-seekable.js";

type Box = { type: string; start: number; size: number; headerSize: number };

/** Top-level boxes, in file order. Null when this is not a box-structured file. */
export function readMp4Boxes(buf: Buffer): Box[] | null {
  const out: Box[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit size, in the eight bytes after the type.
      if (off + 16 > buf.length) return null;
      const big = buf.readBigUInt64BE(off + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      // Runs to end of file.
      size = buf.length - off;
    }
    if (size < headerSize || off + size > buf.length) return null;
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    out.push({ type, start: off, size, headerSize });
    off += size;
  }
  return out.length ? out : null;
}

/** `moov` sits before every byte of media, so a player can start at once. */
export function mp4IsFaststart(buf: Buffer): boolean | null {
  const boxes = readMp4Boxes(buf);
  if (!boxes) return null;
  const moov = boxes.findIndex((b) => b.type === "moov");
  const mdat = boxes.findIndex((b) => b.type === "mdat");
  if (moov < 0 || mdat < 0) return null;
  return moov < mdat;
}

/**
 * Walk a box tree, calling `visit` on every box of `wanted` type.
 *
 * Only containers are descended into; a leaf's payload is never scanned, so a
 * run of bytes inside `mdat` that happens to read like a box header cannot be
 * mistaken for one.
 */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta"]);

function walk(buf: Buffer, base: number, end: number, wanted: Set<string>, visit: (type: string, payloadStart: number, payloadEnd: number) => void): void {
  let off = base;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let headerSize = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(buf.readBigUInt64BE(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerSize || off + size > end) return;
    if (wanted.has(type)) visit(type, off + headerSize, off + size);
    if (CONTAINERS.has(type)) walk(buf, off + headerSize, off + size, wanted, visit);
    off += size;
  }
}

/**
 * Add `shift` to every chunk offset in `moov` that points before `movedBefore`.
 *
 * Mutates the buffer it is given, which is a copy of the original `moov`.
 */
function shiftChunkOffsets(moov: Buffer, shift: number, movedBefore: number): number {
  let changed = 0;
  walk(moov, 0, moov.length, new Set(["stco", "co64"]), (type, from, to) => {
    // version(1) + flags(3) + entry_count(4)
    if (from + 8 > to) return;
    const count = moov.readUInt32BE(from + 4);
    let p = from + 8;
    for (let i = 0; i < count; i++) {
      if (type === "stco") {
        if (p + 4 > to) return;
        const v = moov.readUInt32BE(p);
        if (v < movedBefore) { moov.writeUInt32BE(v + shift, p); changed++; }
        p += 4;
      } else {
        if (p + 8 > to) return;
        const v = moov.readBigUInt64BE(p);
        if (v < BigInt(movedBefore)) { moov.writeBigUInt64BE(v + BigInt(shift), p); changed++; }
        p += 8;
      }
    }
  });
  return changed;
}

/**
 * Put `moov` in front of the media, rewriting the chunk offsets it carries.
 *
 * `ftyp` stays first — it declares the brand, and some players will not look
 * past a file that does not open with it.
 */
export function ensureMp4Faststart(buffer: Buffer): SeekableResult {
  const boxes = readMp4Boxes(buffer);
  if (!boxes) return { buffer, status: "failed", detail: "not a parseable MP4/M4A box structure" };

  const moovIdx = boxes.findIndex((b) => b.type === "moov");
  const mdatIdx = boxes.findIndex((b) => b.type === "mdat");
  if (moovIdx < 0) return { buffer, status: "failed", detail: "no moov box — cannot index this file" };
  if (mdatIdx < 0) return { buffer, status: "failed", detail: "no mdat box — nothing to point at" };
  if (moovIdx < mdatIdx) return { buffer, status: "already-ok" };

  const moovBox = boxes[moovIdx];
  const moov = Buffer.from(buffer.subarray(moovBox.start, moovBox.start + moovBox.size));

  // Everything before moov slides back by exactly moov's size; everything
  // after it does not move at all.
  const moved = shiftChunkOffsets(moov, moovBox.size, moovBox.start);

  const ftyp = boxes[0]?.type === "ftyp" ? boxes[0] : null;
  const parts: Buffer[] = [];
  if (ftyp) parts.push(buffer.subarray(ftyp.start, ftyp.start + ftyp.size));
  parts.push(moov);
  for (const b of boxes) {
    if (b === moovBox || (ftyp && b === ftyp)) continue;
    parts.push(buffer.subarray(b.start, b.start + b.size));
  }

  const out = Buffer.concat(parts);
  if (out.length !== buffer.length) {
    return { buffer, status: "failed", detail: `rebuild changed the size (${buffer.length} -> ${out.length})` };
  }
  return {
    buffer: out,
    status: "fixed",
    detail: `moov moved to the front (${moovBox.size} bytes), ${moved} chunk offset(s) rewritten`,
  };
}

/**
 * Decide faststart from a HEAD alone, for a caller reading ranges.
 *
 * It never needs the whole file: whichever of `moov` and `mdat` appears first
 * settles it. `null` means the head stopped before either — ask for more.
 */
export function mp4FaststartFromHead(head: Buffer): boolean | null {
  let off = 0;
  while (off + 8 <= head.length) {
    let size = head.readUInt32BE(off);
    const type = head.toString("latin1", off + 4, off + 8);
    let headerSize = 8;
    if (size === 1) {
      if (off + 16 > head.length) return null;
      size = Number(head.readBigUInt64BE(off + 8));
      headerSize = 16;
    }
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (type === "moov") return true;   // reached before any mdat
    if (type === "mdat") return false;  // media first, so moov is behind it
    if (size === 0 || size < headerSize) return null;
    off += size;
  }
  return null;
}
