import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { audioDurationFromHeader, flacDuration, wavDuration } from "../src/duration.js";

/** A minimal PCM WAV header plus `dataBytes` of silence. */
function wav({
  sampleRate = 44100,
  channels = 2,
  bits = 16,
  dataBytes = 44100 * 2 * 2, // one second of 44.1k stereo 16-bit
  extraChunk = false,
}: Partial<{
  sampleRate: number;
  channels: number;
  bits: number;
  dataBytes: number;
  extraChunk: boolean;
}> = {}): Buffer {
  const byteRate = sampleRate * channels * (bits / 8);
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);

  // A LIST chunk before `data`, which real files often carry.
  const list = Buffer.alloc(8 + 4);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(4, 4);
  list.write("INFO", 8, "ascii");

  const data = Buffer.alloc(8 + dataBytes);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(dataBytes, 4);

  const body = extraChunk
    ? Buffer.concat([fmt, list, data])
    : Buffer.concat([fmt, data]);

  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}

describe("wavDuration", () => {
  it("reads one second of 44.1k stereo 16-bit", () => {
    assert.equal(wavDuration(wav()), 1);
  });

  it("scales with the data size", () => {
    assert.equal(wavDuration(wav({ dataBytes: 44100 * 2 * 2 * 3 })), 3);
  });

  it("handles mono and other sample rates", () => {
    const buf = wav({ sampleRate: 16000, channels: 1, dataBytes: 16000 * 2 * 5 });
    assert.equal(wavDuration(buf), 5);
  });

  it("walks past a chunk sitting before `data`", () => {
    // LIST/fact chunks before `data` are common; a reader that assumes `data`
    // comes first would read the wrong size.
    assert.equal(wavDuration(wav({ extraChunk: true })), 1);
  });

  it("returns null for something that is not a RIFF/WAVE", () => {
    assert.equal(wavDuration(Buffer.alloc(100)), null);
    assert.equal(wavDuration(Buffer.from("fLaC")), null);
  });

  it("returns null for a truncated buffer rather than guessing", () => {
    assert.equal(wavDuration(Buffer.alloc(10)), null);
  });
});

describe("flacDuration", () => {
  it("returns null for a non-FLAC buffer", () => {
    assert.equal(flacDuration(wav()), null);
    assert.equal(flacDuration(Buffer.alloc(100)), null);
  });

  it("reads totalSamples / sampleRate from STREAMINFO", () => {
    // STREAMINFO: sampleRate 44100 (20 bits), totalSamples 88200 (36 bits)
    // laid out across the packed bytes the parser reads.
    const buf = Buffer.alloc(42);
    buf.write("fLaC", 0, "ascii");
    buf[4] = 0; // STREAMINFO, not last-metadata-block
    const s = 8;
    const sampleRate = 44100;
    const totalSamples = 88200; // two seconds
    buf[s + 10] = (sampleRate >> 12) & 0xff;
    buf[s + 11] = (sampleRate >> 4) & 0xff;
    buf[s + 12] = (sampleRate & 0x0f) << 4;
    buf[s + 13] = Math.floor(totalSamples / 2 ** 32) & 0x0f;
    buf[s + 14] = (totalSamples >>> 24) & 0xff;
    buf[s + 15] = (totalSamples >>> 16) & 0xff;
    buf[s + 16] = (totalSamples >>> 8) & 0xff;
    buf[s + 17] = totalSamples & 0xff;
    assert.equal(flacDuration(buf), 2);
  });
});

describe("audioDurationFromHeader", () => {
  it("picks whichever parser can read the buffer", () => {
    assert.equal(audioDurationFromHeader(wav()), 1);
  });

  it("returns null when neither can", () => {
    assert.equal(audioDurationFromHeader(Buffer.from("not audio at all")), null);
  });
});

describe("a header that claims more audio than the file holds", () => {
  /** What a streaming writer leaves behind: the length was unknown when the
   *  header went out, so the data chunk size is 0xFFFFFFFF. */
  function streamedWav(seconds: number, sampleRate = 16000, channels = 1, bits = 16): Buffer {
    const byteRate = sampleRate * channels * (bits / 8);
    const real = wav({ sampleRate, channels, bits, dataBytes: seconds * byteRate });
    real.writeUInt32LE(0xffffffff, 4); // RIFF size
    real.writeUInt32LE(0xffffffff, real.length - seconds * byteRate - 4); // data size
    return real;
  }

  it("is corrected from the file size when the caller passes one", () => {
    const buf = streamedWav(3);
    assert.equal(wavDuration(buf, buf.length), 3);
  });

  it("is believed when the caller has only part of the file", () => {
    // A caller holding the first 64 KB cannot tell a long file from a lying
    // header, and clamping to what it holds would report every file as short.
    const buf = streamedWav(3);
    assert.ok((wavDuration(buf) ?? 0) > 100000, "unclamped, as before");
  });

  it("leaves an honest header alone", () => {
    const buf = wav({ sampleRate: 16000, channels: 1, bits: 16, dataBytes: 3 * 32000 });
    assert.equal(wavDuration(buf, buf.length), 3);
    assert.equal(wavDuration(buf), 3, "same either way");
  });
});
