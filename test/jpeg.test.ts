import { describe, expect, it } from "vitest";
import { readJpegInfo } from "../src/lib/jpeg";

/** JPEG mínimo válido: SOI + APP0 + SOF0 con las dimensiones dadas + SOS. */
function jpeg(width: number, height: number): ArrayBuffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x08, 0xff, 0xd9]).buffer;
}

describe("jpeg validation", () => {
  it("reads the real dimensions from the SOF marker", () => {
    expect(readJpegInfo(jpeg(512, 384))).toEqual({ width: 512, height: 384 });
  });

  it("rejects bytes that are not a jpeg at all", () => {
    // El caso que importa: `Content-Type: image/jpeg` lo elige quien sube.
    const garbage = new TextEncoder().encode("esto no es una imagen en absoluto");
    expect(readJpegInfo(garbage.buffer as ArrayBuffer)).toBeNull();
  });

  it("rejects a PNG even if it is announced as jpeg", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(readJpegInfo(png.buffer)).toBeNull();
  });

  it("rejects a truncated file", () => {
    expect(readJpegInfo(new Uint8Array([0xff, 0xd8]).buffer)).toBeNull();
    expect(readJpegInfo(new Uint8Array([]).buffer)).toBeNull();
  });

  it("rejects a header that promises a segment longer than the file", () => {
    const lying = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff, 0x08, 0, 1, 0, 1]);
    expect(readJpegInfo(lying.buffer)).toBeNull();
  });

  it("rejects a frame that declares zero size", () => {
    expect(readJpegInfo(jpeg(0, 0))).toBeNull();
  });
});
