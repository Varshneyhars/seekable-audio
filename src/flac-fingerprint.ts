/**
 * A FLAC file's identity, independent of its container.
 *
 * STREAMINFO carries an MD5 of the UNENCODED audio — the decoded samples, not
 * the bytes on disk. That makes it the only fingerprint that survives our own
 * import: `lib/audio/ensure-seekable.ts` injects a SEEKTABLE into every FLAC
 * before it reaches S3, which changes the file's length (one clip went 458,384
 * -> 465,282 bytes) while leaving the audio untouched. Matching a stored object
 * back to the source it came from therefore cannot use size, and comparing two
 * whole files reports a difference that is only metadata.
 *
 * It lives in the first 42 bytes, so a caller can fingerprint an object with a
 * ranged read instead of a download.
 */

/** How many leading bytes `flacAudioMd5` needs. */
export const FLAC_FINGERPRINT_BYTES = 42;

/**
 * MD5 of the decoded audio, as hex, or null when `buf` is not FLAC or the
 * encoder left the field unset (all zeroes is FLAC's "not computed").
 */
export function flacAudioMd5(buf: Buffer): string | null {
  if (buf.length < FLAC_FINGERPRINT_BYTES) return null;
  if (buf.toString("ascii", 0, 4) !== "fLaC") return null;
  // First metadata block must be STREAMINFO (type 0 in the low 7 bits).
  if ((buf[4] & 0x7f) !== 0) return null;
  // Block starts at 8; the MD5 is its last 16 bytes.
  const md5 = buf.subarray(26, 42).toString("hex");
  return /^0{32}$/.test(md5) ? null : md5;
}
