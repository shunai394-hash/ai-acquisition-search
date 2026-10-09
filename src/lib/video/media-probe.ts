/**
 * Whether an MP4/MOV file contains an audio track, by looking for a track
 * handler ("hdlr") of type "soun". Returns null when the container is not
 * ISO-BMFF (e.g. WebM), i.e. "unknown" rather than "silent".
 *
 * Used to make the provider's audio behavior observable: Higgsfield documents
 * audio references and a generate_audio switch, but not whether the supplied
 * narration/BGM ends up in the output, so the stored file is checked instead.
 */
export function mp4HasAudioTrack(bytes: Uint8Array): boolean | null {
  if (bytes.length < 12) return null;
  const isIsoBmff = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70; // "ftyp"
  if (!isIsoBmff) return null;
  let sawHandler = false;
  for (let i = 0; i + 16 <= bytes.length; i++) {
    // "hdlr" box type; handler_type sits after version/flags (4) and pre_defined (4).
    if (bytes[i] === 0x68 && bytes[i + 1] === 0x64 && bytes[i + 2] === 0x6c && bytes[i + 3] === 0x72) {
      sawHandler = true;
      if (bytes[i + 12] === 0x73 && bytes[i + 13] === 0x6f && bytes[i + 14] === 0x75 && bytes[i + 15] === 0x6e) return true; // "soun"
    }
  }
  return sawHandler ? false : null;
}
