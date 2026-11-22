// WebM stores the VP8 keyframes produced by the browser's WebP encoder.
// This avoids dependence on MediaRecorder support in embedded WebViews.
const encoder = new TextEncoder();
// Offline sampling keeps every frame even when a complex 4K scene renders slowly.
export function frameCount(milliseconds, fps = 30) {
  return Math.max(1, Math.ceil(milliseconds * fps / 1000));
}
const bytesOf = (number) => {
  const bytes = [];
  do {
    bytes.unshift(number % 256);
    number = Math.floor(number / 256);
  } while (number);
  return Uint8Array.from(bytes);
};
function sizeBytes(size) {
  for (let length = 1; length <= 8; length++)
    if (size < 2 ** (7 * length) - 1) {
      const bytes = new Uint8Array(length);
      let rest = size;
      for (let i = length - 1; i >= 0; i--) {
        bytes[i] = rest % 256;
        rest = Math.floor(rest / 256);
      }
      bytes[0] |= 1 << (8 - length);
      return bytes;
    }
  throw Error("Video is too large to encode.");
}
function element(id, content) {
  const blob = Array.isArray(content) ? new Blob(content) : new Blob([content]);
  return new Blob([bytesOf(id), sizeBytes(blob.size), blob]);
}
const integer = (id, n) => element(id, bytesOf(n));
const text = (id, s) => element(id, encoder.encode(s));
function float(id, n) {
  const b = new ArrayBuffer(8);
  new DataView(b).setFloat64(0, n);
  return element(id, b);
}
export function captureVp8(canvas) {
  const url = canvas.toDataURL("image/webp", 0.98);
  if (!url.startsWith("data:image/webp"))
    throw Error("WebP video frames are unavailable in this browser.");
  const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = new DataView(bytes.buffer).getUint32(offset + 4, true);
    if (type === "VP8 ") return bytes.slice(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  throw Error("The browser did not produce a VP8 video frame.");
}
export function encodeWebM(frames, width, height, duration) {
  if (!frames.length) throw Error("No video frames were captured.");
  const header = element(0x1a45dfa3, [
    integer(0x4286, 1),
    integer(0x42f7, 1),
    integer(0x42f2, 4),
    integer(0x42f3, 8),
    text(0x4282, "webm"),
    integer(0x4287, 2),
    integer(0x4285, 2),
  ]);
  const info = element(0x1549a966, [
    integer(0x2ad7b1, 1000000),
    text(0x4d80, "Balloon Build"),
    text(0x5741, "Balloon Build"),
    float(0x4489, Math.max(duration, frames.at(-1).time + 1000 / 30)),
  ]);
  const tracks = element(0x1654ae6b, [
    element(0xae, [
      integer(0xd7, 1),
      integer(0x73c5, 1),
      integer(0x83, 1),
      integer(0x9c, 0),
      text(0x86, "V_VP8"),
      element(0xe0, [integer(0xb0, width), integer(0xba, height)]),
    ]),
  ]);
  const clusters = [];
  for (let i = 0; i < frames.length;) {
    const start = Math.round(frames[i].time),
      blocks = [integer(0xe7, start)];
    while (i < frames.length && frames[i].time - start < 30000) {
      const frame = frames[i++],
        relative = Math.max(0, Math.round(frame.time) - start);
      blocks.push(
        element(0xa3, [
          new Uint8Array([0x81, (relative >> 8) & 255, relative & 255, 0x80]),
          frame.data,
        ]),
      );
    }
    clusters.push(element(0x1f43b675, blocks));
  }
  return new Blob([header, element(0x18538067, [info, tracks, ...clusters])], {
    type: "video/webm",
  });
}
