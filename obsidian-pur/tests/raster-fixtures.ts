export const firstFrame = [
  [0, 0, 0, 0], [255, 0, 0, 255], [255, 0, 0, 255],
  [0, 255, 0, 255], [0, 0, 255, 255], [255, 0, 0, 255],
];

export function gifFixture(animated = false): Uint8Array {
  const bytes = [
    ...new TextEncoder().encode("GIF89a"), 3, 0, 2, 0, 0x81, 0, 0,
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ];
  const frame = (pixels: number[]) => {
    const codes = pixels.flatMap(pixel => [4, pixel]);
    codes.push(5);
    const packed: number[] = [];
    let bits = 0, count = 0;
    for (const code of codes) {
      bits |= code << count; count += 3;
      while (count >= 8) { packed.push(bits & 255); bits >>>= 8; count -= 8; }
    }
    if (count) packed.push(bits & 255);
    bytes.push(0x21, 0xf9, 4, 9, 5, 0, 0, 0,
      0x2c, 0, 0, 0, 0, 3, 0, 2, 0, 0, 2, packed.length, ...packed, 0);
  };
  frame([0, 1, 1, 2, 3, 1]);
  if (animated) frame([3, 3, 3, 3, 3, 3]);
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

export function bmpFixture(topDown = false, alpha = false): Uint8Array {
  const header = alpha ? 108 : 40, offset = 14 + header;
  const stride = 12;
  const bytes = new Uint8Array(offset + stride * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([66, 77]);
  view.setUint32(2, bytes.length, true); view.setUint32(10, offset, true);
  view.setUint32(14, header, true); view.setInt32(18, 3, true);
  view.setInt32(22, topDown ? -2 : 2, true); view.setUint16(26, 1, true);
  view.setUint16(28, alpha ? 32 : 24, true); view.setUint32(34, 24, true);
  if (alpha) {
    view.setUint32(30, 3, true);
    [0xff0000, 0xff00, 0xff, 0xff000000].forEach((mask, i) => view.setUint32(54 + i * 4, mask, true));
    view.setUint32(70, 0x73524742, true);
  }
  firstFrame.forEach(([r, g, b, a], i) => {
    const row = topDown ? Math.floor(i / 3) : 1 - Math.floor(i / 3);
    const pos = offset + row * stride + (i % 3) * (alpha ? 4 : 3);
    bytes.set(alpha ? [b, g, r, i === 4 ? 128 : a] : [b, g, r], pos);
  });
  return bytes;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length + (payload.length & 1));
  bytes.set(new TextEncoder().encode(type));
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

export function animatedWebp(frames: Uint8Array[]): Uint8Array {
  const extended = new Uint8Array(10);
  extended[0] = 0x12; extended[4] = 2; extended[7] = 1;
  const chunks = [chunk("VP8X", extended), chunk("ANIM", new Uint8Array(6))];
  for (const frame of frames) {
    const imageChunks: Uint8Array[] = [];
    for (let pos = 12; pos + 8 <= frame.length;) {
      const length = new DataView(frame.buffer, frame.byteOffset).getUint32(pos + 4, true);
      const end = pos + 8 + length + (length & 1);
      const type = new TextDecoder().decode(frame.subarray(pos, pos + 4));
      if (["VP8L", "VP8 ", "ALPH"].includes(type)) imageChunks.push(frame.slice(pos, end));
      pos = end;
    }
    const payload = new Uint8Array(16 + imageChunks.reduce((sum, part) => sum + part.length, 0));
    payload[6] = 2; payload[9] = 1; payload[12] = 50; payload[15] = 2;
    let offset = 16;
    for (const part of imageChunks) { payload.set(part, offset); offset += part.length; }
    chunks.push(chunk("ANMF", payload));
  }
  const bytes = new Uint8Array(12 + chunks.reduce((sum, part) => sum + part.length, 0));
  bytes.set(new TextEncoder().encode("RIFF"));
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
