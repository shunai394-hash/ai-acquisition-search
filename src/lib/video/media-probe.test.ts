import assert from "node:assert/strict";
import test from "node:test";
import { isPlayableVideoContainer, mp4HasAudioTrack } from "@/lib/video/media-probe";

// Minimal ISO-BMFF: ftyp + one hdlr box per track handler type.
function mp4(handlers: string[]) {
  const box = (type: string, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, "ascii");
    return Buffer.concat([header, payload]);
  };
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "binary"));
  const hdlrs = handlers.map((h) => box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from(h, "ascii"), Buffer.alloc(12)])));
  return new Uint8Array(Buffer.concat([ftyp, ...hdlrs]));
}

test("detects whether an MP4 has an audio track", () => {
  assert.equal(mp4HasAudioTrack(mp4(["vide", "soun"])), true);
  assert.equal(mp4HasAudioTrack(mp4(["vide"])), false);
  assert.equal(mp4HasAudioTrack(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), null, "WebM is unknown, not silent");
  assert.equal(isPlayableVideoContainer(mp4(["vide"])), true);
  assert.equal(isPlayableVideoContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), true);
  assert.equal(isPlayableVideoContainer(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0, 0, 0, 0, 0, 0, 0])), false);
});

test("an audio track with zero samples is not treated as audible", () => {
  const box = (type: string, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, "ascii");
    return Buffer.concat([header, payload]);
  };
  const hdlr = (kind: string) => box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from(kind, "ascii")]));
  const stsz = (count: number) => {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(count, 8);
    return box("stsz", payload);
  };
  const trak = (kind: string, samples: number) => box("trak", Buffer.concat([box("mdia", Buffer.concat([hdlr(kind), box("minf", box("stbl", stsz(samples)))]))]));
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "binary"));
  const silent = new Uint8Array(Buffer.concat([ftyp, box("moov", Buffer.concat([trak("vide", 12), trak("soun", 0)]))]));
  const audible = new Uint8Array(Buffer.concat([ftyp, box("moov", Buffer.concat([trak("vide", 12), trak("soun", 4)]))]));
  assert.equal(mp4HasAudioTrack(silent), false);
  assert.equal(mp4HasAudioTrack(audible), true);
});
