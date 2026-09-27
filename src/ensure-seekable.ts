/**
 * "Make this audio seekable in a browser" — one call for every format we
 * import, dispatched by extension:
 *   .flac — inject a SEEKTABLE when the stream has none (below);
 *   .mp3  — write the Info/Xing frame (frame count + seek TOC) when it is
 *           missing, dropping ID3 tags/artwork (mp3-seekable.ts);
 *   .wav  — rewrite header sizes a streaming writer left wrong; transcode a
 *           non-16-bit-PCM stream to 16-bit PCM (wav-seekable.ts);
 *   .m4a/.m4b/.mp4/.aac — move `moov` in front of the media and rewrite the
 *           chunk offsets it carries (mp4-faststart.ts).
 * Every import path and the admin upload routes run the buffer through here
 * before it goes to S3, so what is served is always the fixed version.
 */
import { ensureMp3Seekable, mp3HasSeekInfo } from "./mp3-seekable.js";
import { ensureMp4Faststart, mp4FaststartFromHead } from "./mp4-faststart.js";
import { ensureWavSeekable, wavHeaderIsSound } from "./wav-seekable.js";

export type SeekableStatus = "fixed" | "already-ok" | "skipped" | "failed";

export type SeekableResult = {
  buffer: Buffer;
  status: SeekableStatus;
  detail?: string;
};

const MAX_SEEKPOINTS = 2048;

export function ensureAudioSeekable(
  buffer: Buffer,
  fileName: string,
): SeekableResult {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";

  switch (ext) {
    case "flac":
      return ensureFlacSeekable(buffer);
    case "mp3":
      return ensureMp3Seekable(buffer);
    case "wav":
      return ensureWavSeekable(buffer);
    // The MP4 family shares one container and one fault: `moov` written last.
    case "m4a":
    case "m4b":
    case "mp4":
    case "aac":
      return ensureMp4Faststart(buffer);
    default:
      return { buffer, status: "skipped", detail: `no handler for .${ext}` };
  }
}

// reuses the switch above so the two can never drift apart
export function hasSeekableHandler(fileName: string): boolean {
  return ensureAudioSeekable(Buffer.alloc(0), fileName).status !== "skipped";
}

/**
 * `null` when `head` is too short to tell — fetch more and ask again. A WAV
 * verdict needs the object's full size, since the check is "does the header
 * agree with the file".
 */
export function hasSeekIndex(head: Buffer, fileName: string, totalBytes?: number): boolean | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";

  switch (ext) {
    case "flac":
      return flacHasSeektable(head);
    case "mp3":
      return mp3HasSeekInfo(head);
    case "wav":
      return totalBytes === undefined ? null : wavHeaderIsSound(head, totalBytes);
    case "m4a":
    case "m4b":
    case "mp4":
    case "aac":
      return mp4FaststartFromHead(head);
    default:
      return true;
  }
}

const BLOCK_STREAMINFO = 0;
const BLOCK_SEEKTABLE = 3;
const SEEKPOINT_BYTES = 18;

function flacHasSeektable(head: Buffer): boolean | null {
  if (head.length < 8) return null;
  if (head.toString("ascii", 0, 4) !== "fLaC") return false;

  let off = 4;
  for (;;) {
    if (off + 4 > head.length) return null;
    const type = head[off] & 0x7f;
    if (type === BLOCK_SEEKTABLE) return true;
    if (head[off] & 0x80) return false;
    off += 4 + ((head[off + 1] << 16) | (head[off + 2] << 8) | head[off + 3]);
  }
}

type MetaBlock = { type: number; start: number; end: number };

type FlacLayout = {
  blocks: MetaBlock[];
  firstFrame: number;
  sampleRate: number;
  totalSamples: number;
  blockSize: number;
};

export function ensureFlacSeekable(buffer: Buffer): SeekableResult {
  const layout = readFlacLayout(buffer);
  if (!layout) {
    return { buffer, status: "failed", detail: "not a parseable FLAC stream" };
  }

  if (layout.blocks.some((b) => b.type === BLOCK_SEEKTABLE)) {
    return { buffer, status: "already-ok" };
  }

  const frames = scanFlacFrames(buffer, layout.firstFrame, layout.blockSize);
  if (frames.length < 2) {
    return { buffer, status: "failed", detail: "no frame headers found" };
  }

  const stride = Math.max(1, Math.ceil(frames.length / MAX_SEEKPOINTS));
  const points = frames.filter((_, i) => i % stride === 0);

  return {
    buffer: writeWithSeektable(buffer, layout, points),
    status: "fixed",
    detail: `${points.length} seekpoints from ${frames.length} frames`,
  };
}

function readFlacLayout(buf: Buffer): FlacLayout | null {
  if (buf.length < 42 || buf.toString("ascii", 0, 4) !== "fLaC") return null;

  const blocks: MetaBlock[] = [];
  let off = 4;
  for (;;) {
    if (off + 4 > buf.length) return null;
    const type = buf[off] & 0x7f;
    const isLast = (buf[off] & 0x80) !== 0;
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const end = off + 4 + len;
    if (end > buf.length) return null;
    blocks.push({ type, start: off, end });
    off = end;
    if (isLast) break;
  }

  if (blocks[0]?.type !== BLOCK_STREAMINFO) return null;

  const s = blocks[0].start + 4;
  const blockSize = (buf[s + 2] << 8) | buf[s + 3];
  const sampleRate =
    (buf[s + 10] << 12) | (buf[s + 11] << 4) | (buf[s + 12] >> 4);
  const totalSamples =
    (buf[s + 13] & 0x0f) * 2 ** 32 +
    buf[s + 14] * 2 ** 24 +
    buf[s + 15] * 2 ** 16 +
    buf[s + 16] * 2 ** 8 +
    buf[s + 17];

  if (!sampleRate || !blockSize) return null;
  return { blocks, firstFrame: off, sampleRate, totalSamples, blockSize };
}

type FrameRef = { sample: number; offset: number; blockSamples: number };

function scanFlacFrames(
  buf: Buffer,
  firstFrame: number,
  blockSize: number,
): FrameRef[] {
  const out: FrameRef[] = [];
  for (let p = firstFrame; p < buf.length - 6; p++) {
    const h = readFrameHeader(buf, p);
    if (!h) continue;
    out.push({
      // fixed streams number frames, so scale by the stream block size
      sample: h.variable ? h.number : h.number * blockSize,
      offset: p - firstFrame,
      blockSamples: h.blockSamples,
    });
    p = h.headerEnd - 1;
  }
  return out;
}

const BLOCK_SAMPLES = [
  0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384,
  32768,
];

function readFrameHeader(buf: Buffer, p: number) {
  if (buf[p] !== 0xff || (buf[p + 1] & 0xfc) !== 0xf8) return null;
  if (buf[p + 1] & 0x02) return null;
  if (buf[p + 3] & 0x01) return null;

  const variable = (buf[p + 1] & 0x01) === 1;
  const bsCode = buf[p + 2] >> 4;
  const srCode = buf[p + 2] & 0x0f;
  if (bsCode === 0 || srCode === 15) return null;

  let q = p + 4;
  const n = utf8Width(buf[q]);
  if (!n || q + n > buf.length) return null;
  const number = utf8Value(buf, q, n);
  if (number === null) return null;
  q += n;

  let blockSamples = BLOCK_SAMPLES[bsCode];
  if (bsCode === 6) blockSamples = buf[q] + 1;
  else if (bsCode === 7) blockSamples = ((buf[q] << 8) | buf[q + 1]) + 1;
  q += bsCode === 6 ? 1 : bsCode === 7 ? 2 : 0;
  q += srCode === 12 ? 1 : srCode === 13 || srCode === 14 ? 2 : 0;

  // the sync pattern also occurs inside audio, so the CRC is what confirms it
  if (q >= buf.length || buf[q] !== crc8(buf, p, q)) return null;
  return { number, variable, blockSamples, headerEnd: q + 1 };
}

function utf8Width(b: number): number {
  if (b < 0x80) return 1;
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  if ((b & 0xfc) === 0xf8) return 5;
  if ((b & 0xfe) === 0xfc) return 6;
  if (b === 0xfe) return 7;
  return 0;
}

function utf8Value(buf: Buffer, p: number, width: number): number | null {
  if (width === 1) return buf[p];
  let v = buf[p] & (0x7f >> width);
  for (let i = 1; i < width; i++) {
    if ((buf[p + i] & 0xc0) !== 0x80) return null;
    v = v * 64 + (buf[p + i] & 0x3f);
  }
  return v;
}

function crc8(buf: Buffer, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
  }
  return c;
}

function writeWithSeektable(
  buf: Buffer,
  layout: FlacLayout,
  points: FrameRef[],
): Buffer {
  const table = Buffer.alloc(points.length * SEEKPOINT_BYTES);
  points.forEach((pt, i) => {
    const at = i * SEEKPOINT_BYTES;
    table.writeBigUInt64BE(BigInt(pt.sample), at);
    table.writeBigUInt64BE(BigInt(pt.offset), at + 8);
    // The seekpoint "samples in target frame" field is 16-bit, but a FLAC frame
    // block size can be 65536 (max header value 65535, +1). Clamp to 0xffff so
    // that edge doesn't overflow the UInt16 write — a 1-sample hint error is
    // harmless for seeking.
    table.writeUInt16BE(Math.min(pt.blockSamples, 0xffff), at + 16);
  });

  const header = (type: number, len: number, isLast: boolean) =>
    Buffer.from([
      (isLast ? 0x80 : 0) | type,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);

  const [streamInfo, ...rest] = layout.blocks;
  const parts: Buffer[] = [
    buf.subarray(0, 4),
    withLastFlag(buf.subarray(streamInfo.start, streamInfo.end), false),
    header(BLOCK_SEEKTABLE, table.length, rest.length === 0),
    table,
  ];

  rest.forEach((b, i) => {
    parts.push(withLastFlag(buf.subarray(b.start, b.end), i === rest.length - 1));
  });
  parts.push(buf.subarray(layout.firstFrame));

  return Buffer.concat(parts);
}

function withLastFlag(block: Buffer, isLast: boolean): Buffer {
  const copy = Buffer.from(block);
  copy[0] = isLast ? copy[0] | 0x80 : copy[0] & 0x7f;
  return copy;
}
