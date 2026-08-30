/**
 * Validación de JPEG a partir de los bytes reales.
 *
 * La cabecera `Content-Type` la elige quien sube el fichero, así que no prueba
 * nada: sin esto, cualquier secuencia de bytes con `Content-Type: image/jpeg`
 * acababa guardada en R2 como si fuera un avatar.
 *
 * Se recorre la estructura de segmentos hasta el marcador SOF, que es donde el
 * propio JPEG declara sus dimensiones. Es aritmética sobre un `DataView`: no
 * decodifica la imagen y su coste es despreciable.
 */
export type JpegInfo = { width: number; height: number };

/** Marcadores Start Of Frame. Excluye DHT (C4), DNL (C8) y DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
  );
}

export function readJpegInfo(bytes: ArrayBuffer): JpegInfo | null {
  const view = new DataView(bytes);
  if (view.byteLength < 4) return null;

  // SOI: todo JPEG empieza por FF D8.
  if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < view.byteLength) {
    // Entre segmentos puede haber relleno FF; se salta.
    if (view.getUint8(offset) !== 0xff) {
      offset++;
      continue;
    }
    let marker = view.getUint8(offset + 1);
    while (marker === 0xff && offset + 2 < view.byteLength) {
      offset++;
      marker = view.getUint8(offset + 1);
    }
    offset += 2;

    // Marcadores sin carga útil.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 1 >= view.byteLength) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) return null;

    if (isStartOfFrame(marker)) {
      // SOF: [longitud 2][precisión 1][alto 2][ancho 2]
      if (offset + 7 > view.byteLength) return null;
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // SOS: a partir de aquí vienen los datos comprimidos; las dimensiones ya
    // tendrían que haber aparecido.
    if (marker === 0xda) return null;

    offset += length;
  }

  return null;
}
