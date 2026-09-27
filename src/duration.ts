/**
 * Audio duration straight from the file header — no ffprobe, no decode.
 *
 * Every import flow needs the real length before the file reaches a browser:
 * the DB column backs listing, analytics and (for conversation rating) the
 * listen-coverage denominator. Reading the header is exact for PCM/FLAC and
 * costs nothing, so it beats trusting a manifest or waiting for the client.
 *
 * Both return `null` when the buffer is not the format they parse, so a caller
 * can chain them and fall back to something else.
 */

/**
 * FLAC duration from the STREAMINFO block: totalSamples / sampleRate. The
 * header is the first ~42 bytes.
 */
export function flacDuration(buf: Buffer): number | null {
  if (buf.length < 42 || buf.toString("ascii", 0, 4) !== "fLaC") return null;
  if ((buf[4] & 0x7f) !== 0) return null;
  const s = 8;
  const sampleRate = (buf[s + 10] << 12) | (buf[s + 11] << 4) | (buf[s + 12] >> 4);
  const totalSamples =
    (buf[s + 13] & 0x0f) * 2 ** 32 +
    buf[s + 14] * 2 ** 24 +
    buf[s + 15] * 2 ** 16 +
    buf[s + 16] * 2 ** 8 +
    buf[s + 17];
  if (!sampleRate || !totalSamples) return null;
  return totalSamples / sampleRate;
}

/**
 * PCM WAV duration from the RIFF header: dataChunkBytes / byteRate. Walks the
 * chunk list, because LIST/fact chunks can sit before `data`.
 */
/**
 * WAV duration from the header: declared data-chunk size / byteRate.
 *
 * `totalBytes` is the real size of the FILE, when the caller has it. Pass it
 * and a header that claims more audio than the file can hold is corrected from
 * the file size instead of believed. Omit it — as a caller holding only the
 * first few KB must — and the declared size is taken at face value, which is
 * the only thing a partial buffer can do.
 *
 * The correction matters because streaming writers (ffmpeg to a pipe, sox -t
 * wav -, arecord) do not know the length when they write the header and leave
 * 0xFFFFFFFF or 0 in it. Believing that turns a three-second clip into
 * thirty-seven hours — harmless in a duration column, not harmless at all once
 * a duration decides whether the clip is sent anywhere.
 */
export function wavDuration(buf: Buffer, totalBytes?: number): number | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let off = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataSize = 0;
  let dataOffset = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt " && off + 8 + 16 <= buf.length) {
      channels = buf.readUInt16LE(off + 8 + 2);
      sampleRate = buf.readUInt32LE(off + 8 + 4);
      byteRate = buf.readUInt32LE(off + 8 + 8);
      bits = buf.readUInt16LE(off + 8 + 14);
    } else if (id === "data") {
      dataSize = size;
      dataOffset = off + 8;
      if (byteRate || (sampleRate && channels && bits)) break;
    }
    off += 8 + size + (size & 1); // chunks are word-aligned
  }
  // Same correction scripts/import-hi-blank.ts makes, for the same corpus.
  if (totalBytes !== undefined && dataOffset > 0) {
    if (!dataSize || dataSize === 0xffffffff || dataOffset + dataSize > totalBytes) {
      dataSize = Math.max(0, totalBytes - dataOffset);
    }
  }
  if (!dataSize) return null;
  if (!byteRate) {
    if (sampleRate && channels && bits) byteRate = sampleRate * channels * (bits / 8);
    else return null;
  }
  return byteRate > 0 ? dataSize / byteRate : null;
}

/** Whichever of the two can read this buffer, or null. */
export function audioDurationFromHeader(buf: Buffer): number | null {
  return wavDuration(buf) ?? flacDuration(buf);
}
