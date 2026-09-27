/**
 * The WAV half of "make the audio seekable".
 *
 * PCM WAV seeks by arithmetic — byte offset = time × byte rate — so it needs
 * no index. What breaks it is the header lying about the data: streaming
 * writers (ffmpeg to a pipe, sox -t wav -, arecord, most browser recorders)
 * do not know the length when they write the header and leave the RIFF and
 * `data` sizes as 0 or 0xFFFFFFFF, or the file was truncated after the header
 * was written. A browser believing that reports a nonsense duration and a
 * scrubber that ends early or never ends. The other failure is a WAV a
 * browser cannot decode at all: IEEE float, A-law/µ-law, ADPCM, or 24/32-bit
 * PCM behind WAVE_FORMAT_EXTENSIBLE, which Safari and older Chrome refuse.
 *
 * So: sizes that disagree with the file are rewritten in the header (bytes
 * untouched otherwise); a non-16-bit-PCM stream is transcoded to 16-bit PCM
 * at its own rate and channel count with ffmpeg. Same buffer-in/buffer-out
 * contract as the FLAC and MP3 paths.
 */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import type { SeekableResult } from "./ensure-seekable.js";

export type WavLayout = {
  riffSize: number;
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Where the sample bytes start. */
  dataOffset: number;
  /** The `data` chunk size the header claims. */
  dataSize: number;
  /** The sample bytes actually present after dataOffset. */
  dataActual: number;
};

const FORMAT_PCM = 1;
const FORMAT_EXTENSIBLE = 0xfffe;

export function readWavLayout(buf: Buffer): WavLayout | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  const riffSize = buf.readUInt32LE(4);
  let off = 12;
  let fmt: Pick<WavLayout, "formatTag" | "channels" | "sampleRate" | "bitsPerSample"> | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt " && off + 8 + 16 <= buf.length) {
      let formatTag = buf.readUInt16LE(off + 8);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the
      // SubFormat GUID at +24 inside the chunk.
      if (formatTag === FORMAT_EXTENSIBLE && off + 8 + 26 <= buf.length) formatTag = buf.readUInt16LE(off + 8 + 24);
      fmt = {
        formatTag,
        channels: buf.readUInt16LE(off + 8 + 2),
        sampleRate: buf.readUInt32LE(off + 8 + 4),
        bitsPerSample: buf.readUInt16LE(off + 8 + 14),
      };
    } else if (id === "data") {
      if (!fmt) return null;
      const dataOffset = off + 8;
      return {
        riffSize,
        ...fmt,
        dataOffset,
        dataSize: size,
        dataActual: Math.max(0, buf.length - dataOffset),
      };
    }
    // A streaming header can leave a chunk size of 0xFFFFFFFF too; stop
    // walking rather than jump past the end.
    if (size === 0xffffffff) return null;
    off += 8 + size + (size & 1);
  }
  return null;
}

/** The header's sizes agree with the file and the stream is 16-bit PCM. */
function isClean(l: WavLayout, total: number): boolean {
  const sizesOk = l.dataSize === l.dataActual && l.riffSize === total - 8;
  return sizesOk && l.formatTag === FORMAT_PCM && l.bitsPerSample === 16;
}

/** `null` when `head` stops before the data chunk. */
export function wavHeaderIsSound(head: Buffer, totalBytes: number): boolean | null {
  const l = readWavLayout(head);
  if (!l) return head.length >= 64 * 1024 ? false : null;
  const dataActual = Math.max(0, totalBytes - l.dataOffset);
  return l.dataSize === dataActual && l.riffSize === totalBytes - 8 && l.formatTag === FORMAT_PCM && l.bitsPerSample === 16;
}

function transcodeToPcm16(buffer: Buffer): Buffer | null {
  const dir = mkdtempSync(path.join(tmpdir(), "wavfix-"));
  const src = path.join(dir, "in.wav");
  const dst = path.join(dir, "out.wav");
  try {
    writeFileSync(src, buffer);
    const r = spawnSync(
      process.env.FFMPEG_PATH?.trim() || "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-map_metadata", "-1", "-c:a", "pcm_s16le", "-f", "wav", dst],
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

export function ensureWavSeekable(buffer: Buffer): SeekableResult {
  const layout = readWavLayout(buffer);
  if (!layout) return { buffer, status: "failed", detail: "not a parseable RIFF/WAVE file" };
  if (isClean(layout, buffer.length)) return { buffer, status: "already-ok" };

  const pcm16 = layout.formatTag === FORMAT_PCM && layout.bitsPerSample === 16;
  if (!pcm16) {
    // A stream a browser may not decode: re-encode to 16-bit PCM (ffmpeg also
    // writes correct sizes). Rate and channels are kept.
    const out = transcodeToPcm16(buffer);
    if (!out) return { buffer, status: "failed", detail: "ffmpeg transcode to 16-bit PCM failed (installed? FFMPEG_PATH?)" };
    const after = readWavLayout(out);
    if (!after || !isClean(after, out.length)) return { buffer, status: "failed", detail: "transcode produced an unclean WAV" };
    return {
      buffer: out,
      status: "fixed",
      detail: `format ${layout.formatTag === 3 ? "float" : `0x${layout.formatTag.toString(16)}`} ${layout.bitsPerSample}-bit → 16-bit PCM`,
    };
  }

  // 16-bit PCM whose header sizes are wrong: rewrite the two size fields to
  // what is actually there. The audio bytes are not touched. An odd trailing
  // byte (a truncated sample) is dropped so the data size stays frame-aligned.
  const frame = layout.channels * 2;
  const dataLen = layout.dataActual - (layout.dataActual % frame);
  const out = Buffer.from(buffer.subarray(0, layout.dataOffset + dataLen));
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(dataLen, layout.dataOffset - 4);
  return {
    buffer: out,
    status: "fixed",
    detail: `header said data=${layout.dataSize} riff=${layout.riffSize}; file has data=${dataLen} → sizes rewritten`,
  };
}
