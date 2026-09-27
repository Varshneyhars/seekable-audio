/**
 * The MP3 half of "make the audio seekable" — the counterpart of the FLAC
 * SEEKTABLE fix in ensure-seekable.ts.
 *
 * A browser seeks an MP3 by arithmetic, not by an index: with no length map it
 * guesses the duration from the file size and the FIRST frame's bitrate and
 * lands a seek by that ratio. For a VBR file both are wrong (the scrubber ends
 * early or late, a click lands seconds off), and even a CBR file needs the
 * frame count to report an exact duration. What fixes it is the **Xing/Info
 * frame**: a silent first frame carrying the total frame count, byte count and
 * a 100-point seek TOC, which every browser reads. Podcast MP3s often ship
 * without one — or behind a multi-megabyte ID3 cover image — so this looks for
 * it and, when it is missing, remuxes the stream with ffmpeg (audio copied
 * bit-for-bit, tags and artwork dropped, the Info frame written).
 *
 * Pure parsing + a synchronous ffmpeg call, so it slots into the same
 * buffer-in/buffer-out contract the FLAC path has. `FFMPEG_PATH` overrides the
 * binary, as elsewhere.
 */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import type { SeekableResult } from "./ensure-seekable.js";

export type Mp3Layout = {
  /** Where the audio frames start (after any ID3v2 tag and junk). */
  firstFrame: number;
  /** Bytes of ID3v2 tag ahead of the audio (0 when none). */
  id3Bytes: number;
  /** Bytes of embedded artwork (APIC/PIC frames) inside the ID3v2 tag. */
  artworkBytes: number;
  /** The Xing ("Xing" = VBR, "Info" = CBR) frame, when present. */
  xing: { kind: "Xing" | "Info"; frames: boolean; bytes: boolean; toc: boolean } | null;
};

function syncsafe(b: Buffer, at: number): number {
  return ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
}

/** Size of an ID3v2 tag at offset 0, and the artwork bytes inside it. */
function readId3v2(buf: Buffer): { size: number; artworkBytes: number } | null {
  if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "ID3") return null;
  const major = buf[3];
  const flags = buf[5];
  const size = 10 + syncsafe(buf, 6) + (flags & 0x10 ? 10 : 0);
  let artworkBytes = 0;
  // Walk the frames for APIC/PIC. v2.2 frames: 3-byte id + 3-byte size; v2.3:
  // 4 + 4 (plain big-endian) + 2 flags; v2.4: 4 + 4 (syncsafe) + 2 flags.
  let off = 10 + (flags & 0x40 ? 4 + (major === 4 ? syncsafe(buf, 10) : buf.readUInt32BE(10)) : 0);
  const end = Math.min(buf.length, 10 + syncsafe(buf, 6));
  while (off < end) {
    if (buf[off] === 0) break; // padding
    if (major === 2) {
      if (off + 6 > end) break;
      const id = buf.toString("latin1", off, off + 3);
      const len = (buf[off + 3] << 16) | (buf[off + 4] << 8) | buf[off + 5];
      if (id === "PIC") artworkBytes += len;
      off += 6 + len;
    } else {
      if (off + 10 > end) break;
      const id = buf.toString("latin1", off, off + 4);
      const len = major === 4 ? syncsafe(buf, off + 4) : buf.readUInt32BE(off + 4);
      if (id === "APIC") artworkBytes += len;
      off += 10 + len;
    }
  }
  return { size, artworkBytes };
}

/** Parse the MPEG audio frame header at `at`; null when it is not one. */
function frameHeader(buf: Buffer, at: number): { sideInfo: number } | null {
  if (at + 4 > buf.length) return null;
  const b1 = buf[at + 1];
  const b2 = buf[at + 2];
  const b3 = buf[at + 3];
  if (buf[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 0 = MPEG2.5, 1 = reserved, 2 = MPEG2, 3 = MPEG1
  const layer = (b1 >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = b2 >> 4;
  const sampleIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const mono = (b3 >> 6) === 3;
  const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { sideInfo };
}

/**
 * The file's layout, or null when no MPEG frame is found near the start. Reads
 * only what it needs, so it works on a head slice as long as the slice reaches
 * past the ID3 tag into the first frame (see `mp3HasSeekInfo`).
 */
export function readMp3Layout(buf: Buffer): Mp3Layout | null {
  const id3 = readId3v2(buf);
  const id3Bytes = id3?.size ?? 0;
  // Find the first frame sync after the tag; allow a little junk in between.
  const limit = Math.min(buf.length - 4, id3Bytes + 64 * 1024);
  for (let at = id3Bytes; at <= limit; at++) {
    const h = frameHeader(buf, at);
    if (!h) continue;
    const xingAt = at + 4 + h.sideInfo;
    let xing: Mp3Layout["xing"] = null;
    if (xingAt + 8 <= buf.length) {
      const tag = buf.toString("latin1", xingAt, xingAt + 4);
      if (tag === "Xing" || tag === "Info") {
        const flags = buf.readUInt32BE(xingAt + 4);
        xing = { kind: tag, frames: !!(flags & 1), bytes: !!(flags & 2), toc: !!(flags & 4) };
      }
    }
    return { firstFrame: at, id3Bytes, artworkBytes: id3?.artworkBytes ?? 0, xing };
  }
  return null;
}

/** An Info/Xing frame that carries what a seek needs: frame count + TOC. */
function seekReady(layout: Mp3Layout): boolean {
  return !!layout.xing && layout.xing.frames && layout.xing.toc;
}

/**
 * `null` when `head` stops before the first audio frame (a large cover image
 * can push it megabytes in) — fetch more and ask again.
 */
export function mp3HasSeekInfo(head: Buffer): boolean | null {
  if (head.length < 10) return null;
  const id3 = readId3v2(head);
  if (id3 && head.length < id3.size + 4 + 32 + 8) return null;
  const layout = readMp3Layout(head);
  if (!layout) return head.length >= (id3?.size ?? 0) + 64 * 1024 ? false : null;
  return seekReady(layout);
}

/**
 * Remux with ffmpeg: audio frames copied untouched, ID3 tags and artwork
 * dropped, an Info/Xing frame with frame count and TOC written up front.
 */
function remux(buffer: Buffer): Buffer | null {
  const dir = mkdtempSync(path.join(tmpdir(), "mp3seek-"));
  const src = path.join(dir, "in.mp3");
  const dst = path.join(dir, "out.mp3");
  try {
    writeFileSync(src, buffer);
    const r = spawnSync(
      process.env.FFMPEG_PATH?.trim() || "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-map_metadata", "-1", "-c:a", "copy", "-write_xing", "1", "-f", "mp3", dst],
      { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1024 * 1024 },
    );
    if (r.error || r.status !== 0) return null;
    return readFileSync(dst);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ensureMp3Seekable(buffer: Buffer): SeekableResult {
  const layout = readMp3Layout(buffer);
  if (!layout) return { buffer, status: "failed", detail: "no MPEG audio frame found" };
  if (seekReady(layout)) return { buffer, status: "already-ok" };

  const out = remux(buffer);
  if (!out) return { buffer, status: "failed", detail: "ffmpeg remux failed (installed? FFMPEG_PATH?)" };
  const after = readMp3Layout(out);
  if (!after || !seekReady(after)) {
    return { buffer, status: "failed", detail: "remux produced no Info/Xing frame" };
  }
  const dropped = layout.id3Bytes;
  return {
    buffer: out,
    status: "fixed",
    detail: `${layout.xing ? `${layout.xing.kind} frame without TOC` : "no Info/Xing frame"} → Info frame + TOC written${dropped ? `, ${(dropped / 1024).toFixed(0)} KB of ID3 (${(layout.artworkBytes / 1024).toFixed(0)} KB artwork) dropped` : ""}`,
  };
}
