'use strict';

importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

const { PDFDocument, PDFDict, PDFRawStream, PDFArray, PDFName, PDFNumber, decodePDFRawStream } = PDFLib;
const MiB = 1024 * 1024;
const perfiles = {
  equilibrada: { lado: 1800, calidad: 0.77 },
  maxima: { lado: 1150, calidad: 0.54 }
};

const clave = nombre => PDFName.of(nombre);
const nombrePDF = (dict, clavePDF) => dict.lookupMaybe(clave(clavePDF), PDFName)?.asString();
const numeroPDF = (dict, clavePDF) => dict.lookupMaybe(clave(clavePDF), PDFNumber)?.asNumber();

function filtros(dict) {
  const filtro = dict.lookupMaybe(clave('Filter'), PDFName, PDFArray);
  if (filtro instanceof PDFName) return [filtro.asString()];
  return filtro?.asArray().map((_, i) => filtro.lookup(i, PDFName).asString()) ?? [];
}

function jpegOriginal(objeto, tipos) {
  if (objeto.dict.has(clave('DecodeParms')) || tipos.at(-1) !== '/DCTDecode') return;
  if (tipos.length === 1) return objeto.contents;
  if (tipos.length !== 2 || !['/ASCII85Decode', '/ASCIIHexDecode'].includes(tipos[0])) return;
  const dict = objeto.dict.clone();
  dict.set(clave('Filter'), clave(tipos[0].slice(1)));
  return decodePDFRawStream({ dict, contents: objeto.contents }).decode();
}

async function imagenRGB(objeto, ancho, alto, canales) {
  const params = objeto.dict.lookupMaybe(clave('DecodeParms'), PDFDict);
  if (params && (numeroPDF(params, 'Predictor') ?? 1) !== 1) return;
  if (typeof DecompressionStream === 'undefined') return;

  const esperado = ancho * alto * canales;
  const lector = new Blob([objeto.contents]).stream()
    .pipeThrough(new DecompressionStream('deflate')).getReader();
  const pixeles = new Uint8Array(esperado);
  let posicion = 0;

  try {
    while (true) {
      const { value, done } = await lector.read();
      if (done) break;
      if (posicion + value.length > esperado) return;
      pixeles.set(value, posicion);
      posicion += value.length;
    }
  } finally {
    await lector.cancel().catch(() => {});
  }

  if (posicion !== esperado) return;
  const lienzo = new OffscreenCanvas(ancho, alto);
  const contexto = lienzo.getContext('2d');
  const imagen = contexto.createImageData(ancho, alto);
  for (let i = 0, j = 0; i < imagen.data.length; i += 4, j += canales) {
    imagen.data[i] = pixeles[j];
    imagen.data[i + 1] = pixeles[j + (canales === 3 ? 1 : 0)];
    imagen.data[i + 2] = pixeles[j + (canales === 3 ? 2 : 0)];
    imagen.data[i + 3] = 255;
  }
  contexto.putImageData(imagen, 0, 0);
  return lienzo;
}

async function reducirImagen(objeto, perfil, jpeg, tipos) {
  const { dict, contents } = objeto;
  if (!perfil || typeof OffscreenCanvas === 'undefined' || contents.length < 20_000) return;
  if (numeroPDF(dict, 'BitsPerComponent') !== 8) return;
  if (['SMask', 'Mask', 'ImageMask', 'Decode', 'SMaskInData', 'Alternates'].some(k => dict.has(clave(k)))) return;
  const color = nombrePDF(dict, 'ColorSpace');
  if (color !== '/DeviceRGB' && color !== '/DeviceGray') return;

  const ancho = numeroPDF(dict, 'Width');
  const alto = numeroPDF(dict, 'Height');
  if (!Number.isInteger(ancho) || !Number.isInteger(alto) || ancho < 1 || alto < 1 || ancho * alto > 28_000_000) return;

  let imagen;
  if (jpeg) {
    imagen = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), {
      imageOrientation: 'none', colorSpaceConversion: 'none'
    });
  } else if (tipos.length === 1 && tipos[0] === '/FlateDecode') {
    imagen = await imagenRGB(objeto, ancho, alto, color === '/DeviceRGB' ? 3 : 1);
  }
  if (!imagen) return;

  const escala = Math.min(1, perfil.lado / Math.max(ancho, alto));
  const nuevoAncho = Math.max(1, Math.round(ancho * escala));
  const nuevoAlto = Math.max(1, Math.round(alto * escala));
  const lienzo = new OffscreenCanvas(nuevoAncho, nuevoAlto);

  try {
    if (imagen.width !== ancho || imagen.height !== alto) return;
    const contexto = lienzo.getContext('2d', { alpha: false });
    contexto.imageSmoothingQuality = 'high';
    contexto.drawImage(imagen, 0, 0, nuevoAncho, nuevoAlto);
    const salida = await lienzo.convertToBlob({ type: 'image/jpeg', quality: perfil.calidad });
    if (salida.type !== 'image/jpeg' || salida.size >= (jpeg?.length ?? contents.length) * 0.95) return;

    const nuevo = dict.clone();
    nuevo.set(clave('Width'), PDFNumber.of(nuevoAncho));
    nuevo.set(clave('Height'), PDFNumber.of(nuevoAlto));
    nuevo.set(clave('ColorSpace'), clave('DeviceRGB'));
    nuevo.set(clave('Filter'), clave('DCTDecode'));
    nuevo.delete(clave('DecodeParms'));
    return PDFRawStream.of(nuevo, new Uint8Array(await salida.arrayBuffer()));
  } finally {
    if (typeof imagen.close === 'function') imagen.close();
    else imagen.width = imagen.height = 1;
    lienzo.width = lienzo.height = 1;
  }
}

async function optimizar(blob, nivel) {
  if (blob.size > 128 * MiB) return { nota: 'PDF grande · original' };
  const inicio = await blob.slice(0, 1024).text();
  if (!inicio.includes('%PDF-')) return { nota: 'Archivo ilegible · original' };

  let documento;
  try {
    documento = await PDFDocument.load(await blob.arrayBuffer(), {
      updateMetadata: false, throwOnInvalidObject: true
    });
  } catch (error) {
    return { nota: /encrypt/i.test(error.message) ? 'PDF protegido · original' : 'PDF no compatible · original' };
  }

  const objetos = documento.context.enumerateIndirectObjects();
  const protegido = documento.catalog.has(clave('Perms')) || objetos.some(([, obj]) =>
    obj instanceof PDFDict && (
      obj.has(clave('ByteRange')) || obj.has(clave('XFA')) ||
      ['/Sig', '/DocTimeStamp'].includes(nombrePDF(obj, 'Type')) ||
      nombrePDF(obj, 'FT') === '/Sig'
    )
  );
  if (protegido) return { nota: 'PDF firmado o especial · original' };

  for (const [referencia, objeto] of objetos) {
    if (!(objeto instanceof PDFRawStream)) continue;
    const { dict, contents } = objeto;
    try {
      const tipos = filtros(dict);
      if (nombrePDF(dict, 'Subtype') === '/Image') {
        const jpeg = jpegOriginal(objeto, tipos);
        const reducido = await reducirImagen(objeto, perfiles[nivel], jpeg, tipos);
        if (reducido) {
          documento.context.assign(referencia, reducido);
          continue;
        }
        if (jpeg && tipos.length > 1 && jpeg.length < contents.length) {
          const nuevo = dict.clone();
          nuevo.set(clave('Filter'), clave('DCTDecode'));
          documento.context.assign(referencia, PDFRawStream.of(nuevo, jpeg));
          continue;
        }
      }
      if (tipos.length || dict.has(clave('DecodeParms')) || contents.length < 4096 ||
          nombrePDF(dict, 'Type') === '/Metadata' || typeof CompressionStream === 'undefined') continue;

      const stream = new Blob([contents]).stream().pipeThrough(new CompressionStream('deflate'));
      const comprimido = new Uint8Array(await new Response(stream).arrayBuffer());
      if (comprimido.length + 35 >= contents.length) continue;
      const nuevo = dict.clone();
      nuevo.set(clave('Filter'), clave('FlateDecode'));
      documento.context.assign(referencia, PDFRawStream.of(nuevo, comprimido));
    } catch {
      // Si no se reconoce el formato interno, se conserva el objeto original.
    }
  }

  const bytes = await documento.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: true
  });
  return bytes.length < blob.size ? { bytes } : { nota: 'Tamaño original' };
}

self.onmessage = async ({ data: { blob, nivel } }) => {
  try {
    const resultado = await optimizar(blob, nivel);
    self.postMessage(resultado, resultado.bytes ? [resultado.bytes.buffer] : []);
  } catch {
    self.postMessage({ nota: 'PDF no compatible · original' });
  }
};
