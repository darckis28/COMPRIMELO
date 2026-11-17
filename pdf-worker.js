/* Optimize image streams and identify documents that can be converted to page images. */
'use strict';
importScripts('./vendor/pdf-lib.min.js');

const { PDFDocument, PDFRawStream, PDFDict, PDFName, PDFArray, PDFNumber, decodePDFRawStream } = PDFLib;
const profiles = {
  balanced: { dimension: 1800, quality: 0.77 },
  strong: { dimension: 1150, quality: 0.54 },
};
const maxPdfBytes = 128 * 1024 * 1024;
const maxImagePixels = 28_000_000;

function key(name) {
  return PDFName.of(name);
}

function getName(dict, name) {
  return dict.lookupMaybe(key(name), PDFName)?.asString();
}

function streamFilters(dict) {
  const filter = dict.lookupMaybe(key('Filter'), PDFName, PDFArray);
  if (filter instanceof PDFName) return [filter.asString()];
  return filter?.asArray().map((_, index) => filter.lookup(index, PDFName).asString()) ?? [];
}

function unwrapJpeg(stream, filters) {
  if (stream.dict.has(key('DecodeParms')) || filters.at(-1) !== '/DCTDecode') return;
  if (filters.length === 1) return stream.contents;
  if (filters.length !== 2 || !['/ASCII85Decode', '/ASCIIHexDecode'].includes(filters[0])) return;
  const dict = stream.dict.clone();
  dict.set(key('Filter'), key(filters[0].slice(1)));
  return decodePDFRawStream({ dict, contents: stream.contents }).decode();
}

function getNumber(dict, name, fallback) {
  return dict.lookupMaybe(key(name), PDFNumber)?.asNumber() ?? fallback;
}

function isProtected(dict) {
  return getName(dict, 'Type') === '/Sig' ||
    getName(dict, 'Type') === '/DocTimeStamp' ||
    getName(dict, 'FT') === '/Sig' ||
    dict.has(key('ByteRange')) ||
    dict.has(key('XFA'));
}

async function inflateImage(contents, limit) {
  const stream = new Blob([contents]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const bytes = new Uint8Array(limit);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, offset);
      if (offset + value.length > limit) throw new Error('Imagen demasiado grande');
      bytes.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function paeth(a, b, c) {
  const estimate = a + b - c;
  const distances = [Math.abs(estimate - a), Math.abs(estimate - b), Math.abs(estimate - c)];
  if (distances[0] <= distances[1] && distances[0] <= distances[2]) return a;
  return distances[1] <= distances[2] ? b : c;
}

function undoPrediction(bytes, width, height, channels, prediction) {
  const rowSize = width * channels;
  if (prediction === 1) {
    if (bytes.length !== rowSize * height) throw new Error('Tamaño de imagen inesperado');
    return bytes;
  }
  if (prediction === 2) {
    if (bytes.length !== rowSize * height) throw new Error('Tamaño de imagen inesperado');
    for (let row = 0; row < bytes.length; row += rowSize) {
      for (let i = row + channels; i < row + rowSize; i++) bytes[i] += bytes[i - channels];
    }
    return bytes;
  }

  if (prediction < 10 || prediction > 15 || bytes.length !== (rowSize + 1) * height) {
    throw new Error('Predictor de imagen incompatible');
  }

  const pixels = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y++) {
    const position = y * rowSize;
    const source = position + y;
    const filter = bytes[source];
    if (filter > 4) throw new Error('Filtro de imagen incompatible');
    for (let x = 0; x < rowSize; x++) {
      const index = position + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const up = y ? pixels[index - rowSize] : 0;
      const upperLeft = y && x >= channels ? pixels[index - rowSize - channels] : 0;
      let offset = 0;
      switch (filter) {
        case 1: offset = left; break;
        case 2: offset = up; break;
        case 3: offset = (left + up) >> 1; break;
        case 4: offset = paeth(left, up, upperLeft); break;
      }
      pixels[index] = bytes[source + 1 + x] + offset;
    }
  }
  return pixels;
}

async function flatImage(stream, width, height, channels) {
  const parameter = stream.dict.lookupMaybe(key('DecodeParms'), PDFDict, PDFArray);
  if (parameter instanceof PDFArray && parameter.size() !== 1) return;
  const config = parameter instanceof PDFArray ? parameter.lookupMaybe(0, PDFDict) : parameter;
  const prediction = config ? getNumber(config, 'Predictor', 1) : 1;
  if (prediction !== 1 && (
    getNumber(config, 'Columns', 1) !== width ||
    getNumber(config, 'Colors', 1) !== channels ||
    getNumber(config, 'BitsPerComponent', 8) !== 8
  )) return;

  const bytes = await inflateImage(stream.contents, (width * channels + 1) * height);
  const pixels = undoPrediction(bytes, width, height, channels, prediction);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  for (let i = 0, source = 0; i < image.data.length; i += 4, source += channels) {
    image.data[i] = pixels[source];
    image.data[i + 1] = pixels[source + (channels === 3 ? 1 : 0)];
    image.data[i + 2] = pixels[source + (channels === 3 ? 2 : 0)];
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function replaceImage(document, reference, stream, profile) {
  const { dict, contents } = stream;
  if (contents.length < 20_000 || getNumber(dict, 'BitsPerComponent') !== 8) return;
  if (['SMask', 'Mask', 'ImageMask', 'Decode', 'SMaskInData', 'Alternates'].some(name => dict.has(key(name)))) return;

  const color = getName(dict, 'ColorSpace');
  if (color !== '/DeviceRGB' && color !== '/DeviceGray') return;

  const width = getNumber(dict, 'Width');
  const height = getNumber(dict, 'Height');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > maxImagePixels) return;

  const filters = streamFilters(dict);
  const jpegBytes = unwrapJpeg(stream, filters);
  let image;
  if (jpegBytes) {
    image = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }), {
      imageOrientation: 'none',
      colorSpaceConversion: 'none',
    });
  } else if (filters.length === 1 && filters[0] === '/FlateDecode') {
    image = await flatImage(stream, width, height, color === '/DeviceRGB' ? 3 : 1);
  }

  if (!image) return;
  const scale = Math.min(profile.dimension / Math.max(width, height), 1);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);

  try {
    if (image.width !== width || image.height !== height) return;
    const context = canvas.getContext('2d', { alpha: false });
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: profile.quality });
    if (jpeg.type !== 'image/jpeg' || jpeg.size > contents.length * 0.95) return;

    const output = dict.clone();
    output.set(key('Width'), PDFNumber.of(targetWidth));
    output.set(key('Height'), PDFNumber.of(targetHeight));
    output.set(key('ColorSpace'), key('DeviceRGB'));
    output.set(key('Filter'), key('DCTDecode'));
    output.delete(key('DecodeParms'));
    document.context.assign(reference, PDFRawStream.of(output, new Uint8Array(await jpeg.arrayBuffer())));
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    if (typeof image.close === 'function') image.close();
    else {
      image.width = 1;
      image.height = 1;
    }
  }
}

async function compressPlainStream(document, reference, stream) {
  if (typeof CompressionStream === 'undefined') return;
  const { dict, contents } = stream;
  if (contents.length < 4096 || dict.has(key('DecodeParms'))) return;
  if (dict.has(key('Filter'))) {
    if (getName(dict, 'Subtype') !== '/Image') return;
    const filters = streamFilters(dict);
    if (filters.length < 2) return;
    const bytes = unwrapJpeg(stream, filters);
    if (!bytes || bytes.length >= contents.length) return;
    const output = dict.clone();
    output.set(key('Filter'), key('DCTDecode'));
    document.context.assign(reference, PDFRawStream.of(output, bytes));
    return;
  }
  if (getName(dict, 'Type') === '/Metadata') return;

  const compressed = await new Response(
    new Blob([contents]).stream().pipeThrough(new CompressionStream('deflate'))
  ).arrayBuffer();

  if (compressed.byteLength + 35 >= contents.length) return;
  const output = dict.clone();
  output.set(key('Filter'), key('FlateDecode'));
  document.context.assign(reference, PDFRawStream.of(output, new Uint8Array(compressed)));
}

async function optimize(blob, mode) {
  const head = new TextDecoder('ascii').decode(await blob.slice(0, 1024).arrayBuffer());
  if (!head.includes('%PDF-')) return { detail: 'Archivo ilegible' };
  if (blob.size > maxPdfBytes) return { detail: 'PDF grande', reason: 'Se conservó el original porque supera los 128 MB por documento.' };

  let document;
  try {
    document = await PDFDocument.load(await blob.arrayBuffer(), {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
  } catch (error) {
    if (/encrypt/i.test(error?.message ?? '')) return { detail: 'PDF protegido' };
    return { detail: 'PDF no compatible' };
  }

  const objects = document.context.enumerateIndirectObjects();
  if (document.catalog.has(key('Perms')) || objects.some(([, object]) => object instanceof PDFDict && isProtected(object))) {
    return { detail: 'PDF firmado o especial', reason: 'Se conservó el original para proteger firmas o formularios especiales.' };
  }

  if (mode === 'resolution') {
    const names = document.catalog.lookupMaybe(key('Names'), PDFDict);
    if (document.catalog.has(key('AcroForm')) || document.catalog.has(key('Collection')) ||
        document.catalog.has(key('AF')) || names?.has(key('EmbeddedFiles'))) {
      return { detail: 'PDF interactivo', reason: 'Se conservó el original para mantener formularios o archivos adjuntos.' };
    }
    const images = objects.map(([, object]) => object).filter(object =>
      object instanceof PDFRawStream && getName(object.dict, 'Subtype') === '/Image'
    );
    const bilevel = images.length > 0 && images.every(image =>
      getNumber(image.dict, 'BitsPerComponent') === 1 && getName(image.dict, 'ColorSpace') === '/DeviceGray'
    );
    return { rasterize: true, bilevel };
  }

  const profile = profiles[mode];
  for (const [ref, object] of objects) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      if (profile && typeof OffscreenCanvas !== 'undefined' && getName(object.dict, 'Subtype') === '/Image') {
        await replaceImage(document, ref, object, profile);
        if (document.context.lookup(ref) !== object) continue;
      }
      await compressPlainStream(document, ref, object);
    } catch {
      // Keep the untouched stream if its format cannot be safely optimized.
    }
  }

  const output = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: true,
    objectsPerTick: Infinity,
  });
  if (output.length < blob.size) return { bytes: output };
  return { detail: 'Tamaño original', reason: 'El PDF original ya ocupa igual o menos espacio.' };
}

self.onmessage = async ({ data: { blob, mode } }) => {
  try {
    const result = await optimize(blob, mode);
    self.postMessage(result, result.bytes ? [result.bytes.buffer] : []);
  } catch {
    self.postMessage({ detail: 'PDF no compatible' });
  }
};
