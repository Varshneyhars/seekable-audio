# seekable-audio

Make an audio buffer seekable in a browser, and identify a FLAC without downloading it.

Buffer in, buffer out. No temp files except in the two conversion paths that call
ffmpeg, and those are marked below.

```bash
npm i seekable-audio
```

## Why

A file a browser cannot seek in is a file an annotator cannot scrub, and the
reasons are format-specific and invisible until someone drags a playhead:

- **FLAC** written as a stream carries no SEEKTABLE, so a player has to decode
  from the start to reach the middle.
- **WAV** written to a pipe cannot know its own length, so ffmpeg, sox, arecord
  and most browser recorders leave `0xFFFFFFFF` (or `0`) in the RIFF and `data`
  size fields. Browsers tolerate it; strict decoders reject the file outright.
- **MP3** without an Info/Xing frame has no frame count and no seek table, so a
  VBR stream seeks to the wrong place.

Each is a small, well-specified fix. This does all three behind one call.

## Usage

```ts
import { ensureAudioSeekable } from "seekable-audio";

const res = ensureAudioSeekable(buffer, "clip.flac");
// res.status: "fixed" | "already-ok" | "skipped" | "failed"
// res.buffer: the fixed bytes (the original when nothing needed doing)
// res.detail: what was wrong, when something was
```

Dispatch is by file extension, so pass the name you have.

### Identify a FLAC from 42 bytes

A FLAC's STREAMINFO carries an MD5 of the **decoded** audio. It sits in the
first 42 bytes, so a ranged read identifies a remote file without fetching it —
and because it describes the samples rather than the container, it survives
retagging and survives this library's own SEEKTABLE injection.

```ts
import { flacAudioMd5, FLAC_FINGERPRINT_BYTES } from "seekable-audio";

const head = await fetchRange(url, 0, FLAC_FINGERPRINT_BYTES); // 42 bytes
const id = flacAudioMd5(head); // hex, or null if not FLAC / encoder left it unset
```

That is the difference between comparing two buckets of audio for a few KB and
downloading both of them. S3 ETags cannot do this job on an SSE-KMS bucket,
where the ETag is not the content MD5 at all.

### Duration without decoding

```ts
import { audioDurationFromHeader, flacDuration, wavDuration } from "seekable-audio";

audioDurationFromHeader(buffer); // seconds, or null
```

Exact for FLAC (STREAMINFO) and PCM WAV (header arithmetic). No decode, no
ffprobe.

### Check before you fix

```ts
import { hasSeekIndex, wavHeaderIsSound, mp3HasSeekInfo } from "seekable-audio";

hasSeekIndex(head, "clip.flac", totalBytes);
// true | false | null — null means "this head is too short to decide",
// so a caller reading ranges knows to ask for more rather than guess.
```

## What needs ffmpeg

Everything above is pure JavaScript. Two paths are not, because they re-encode
rather than repair:

| path | why |
|---|---|
| WAV that is not 16-bit PCM | transcoded to 16-bit PCM, keeping rate and channels |
| MP3 missing its Info/Xing frame | remuxed, audio frames copied untouched, ID3 and artwork dropped |

They call `ffmpeg` on `PATH`, or `FFMPEG_PATH` if set, and return
`status: "failed"` with a reason when it is missing. A **16-bit PCM WAV with
wrong header sizes is repaired in pure JS** — the sizes are rewritten and the
audio bytes are never touched, which is the common streaming case.

## API

| export | |
|---|---|
| `ensureAudioSeekable(buffer, fileName)` | the one call; dispatches on extension |
| `ensureWavSeekable(buffer)` / `ensureMp3Seekable(buffer)` | one format |
| `hasSeekIndex(head, fileName, totalBytes?)` | is a fix needed, from a head |
| `wavHeaderIsSound(head, totalBytes)` / `mp3HasSeekInfo(head)` | per format |
| `readWavLayout(buffer)` / `readMp3Layout(buffer)` | parsed structure |
| `flacAudioMd5(head)` / `FLAC_FINGERPRINT_BYTES` | the 42-byte fingerprint |
| `audioDurationFromHeader` / `flacDuration` / `wavDuration` | seconds, or null |

`null` means "not this format, or cannot tell" everywhere — never a thrown error
and never a wrong answer.

## Provenance

Extracted from a speech-annotation platform where it runs on every imported
file. The WAV repair exists because a batch of streamed clips reported 37 hours
each from a `0xFFFFFFFF` data size; the FLAC fingerprint exists because 118
clips were overwritten in S3 and ETags could not tell which was which.

## License

MIT
