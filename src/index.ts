/**
 * seekable-audio — make an audio buffer seekable in a browser, and identify a
 * FLAC without downloading it.
 *
 * Every export is buffer-in, buffer-out. Nothing writes to disk except the two
 * conversion paths that shell out to ffmpeg, and those say so.
 */
export { ensureAudioSeekable, hasSeekIndex } from "./ensure-seekable.js";
export type { SeekableResult, SeekableStatus } from "./ensure-seekable.js";

export { ensureWavSeekable, readWavLayout, wavHeaderIsSound } from "./wav-seekable.js";
export type { WavLayout } from "./wav-seekable.js";

export { ensureMp3Seekable, mp3HasSeekInfo, readMp3Layout } from "./mp3-seekable.js";

export {
  ensureMp4Faststart,
  mp4IsFaststart,
  mp4FaststartFromHead,
  readMp4Boxes,
} from "./mp4-faststart.js";

export { flacAudioMd5, FLAC_FINGERPRINT_BYTES } from "./flac-fingerprint.js";

export { audioDurationFromHeader, flacDuration, wavDuration } from "./duration.js";
