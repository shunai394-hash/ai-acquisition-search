/**
 * Whether an MP4/MOV file contains an audio track.
 *
 * Walks ISO-BMFF boxes instead of scanning raw bytes, so "soun" / "hdlr"
 * strings inside media samples are not treated as tracks. An audio track whose
 * sample count is known to be zero is silent and returns false. Returns null
 * when the container is not ISO-BMFF (e.g. WebM), i.e. "unknown" rather than
 * "silent".
 *
 * Higgsfield documents audio references and a generate_audio switch, but not
 * whether the supplied narration/BGM ends up in the output, so the stored file
 * is checked instead.
 */

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "moof", "traf"]);

function readU32(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i]);
  return text;
}

function readBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (type: string, payloadStart: number, payloadEnd: number) => void,
) {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = readU32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) return;
      if (readU32(bytes, offset + 8) !== 0) return;
      size = readU32(bytes, offset + 12);
      header = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return;
    visit(type, offset + header, offset + size);
    offset += size;
  }
}

type TrackInfo = { handler: string | null; samples: number | null };

function inspectTrack(bytes: Uint8Array, start: number, end: number, track: TrackInfo) {
  readBoxes(bytes, start, end, (type, payloadStart, payloadEnd) => {
    if (type === "hdlr" && payloadEnd >= payloadStart + 12) {
      track.handler = ascii(bytes, payloadStart + 8, 4);
      return;
    }
    if (type === "stsz" && payloadEnd >= payloadStart + 12) {
      track.samples = readU32(bytes, payloadStart + 8);
      return;
    }
    if (type === "mdat" || type === "free" || type === "skip" || type === "udta") return;
    if (CONTAINERS.has(type) || type === "moov") inspectTrack(bytes, payloadStart, payloadEnd, track);
  });
}

export function isPlayableVideoContainer(bytes: Uint8Array) {
  if (bytes.length < 12) return false;
  const mp4 = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return mp4 || webm;
}

export function mp4HasAudioTrack(bytes: Uint8Array): boolean | null {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== "ftyp") return null;

  let sawHandler = false;
  let sawAudio = false;
  let audioSamples = 0;
  let sawAudioSamples = false;

  const consume = (track: TrackInfo) => {
    if (!track.handler) return;
    sawHandler = true;
    if (track.handler !== "soun") return;
    sawAudio = true;
    if (track.samples == null) return;
    sawAudioSamples = true;
    audioSamples += track.samples;
  };

  const walk = (start: number, end: number) => {
    readBoxes(bytes, start, end, (type, payloadStart, payloadEnd) => {
      if (type === "trak") {
        const track: TrackInfo = { handler: null, samples: null };
        inspectTrack(bytes, payloadStart, payloadEnd, track);
        consume(track);
        return;
      }
      if (type === "hdlr" && payloadEnd >= payloadStart + 12) {
        consume({ handler: ascii(bytes, payloadStart + 8, 4), samples: null });
        return;
      }
      if (type === "moov" || type === "moof") walk(payloadStart, payloadEnd);
    });
  };
  walk(0, bytes.length);

  if (!sawHandler) return null;
  if (!sawAudio) return false;
  if (sawAudioSamples && audioSamples === 0) return false;
  return true;
}


/** Read the persisted audio-track flag from the video-job API asset shape. */
export function audioTrackFromAsset(asset: unknown): boolean | null {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return null;
  const record = asset as Record<string, unknown>;
  if (typeof record.has_audio_track === "boolean") return record.has_audio_track;
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const nested = (metadata as Record<string, unknown>).has_audio_track;
  return typeof nested === "boolean" ? nested : null;
}
