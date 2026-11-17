import { AnnotationMode, getDocument, GlobalWorkerOptions, PDFWorker } from './vendor/pdfjs/build/pdf.min.mjs';
import './vendor/pdf-lib.min.js';

const { PDFDocument, drawObject, popGraphicsState, pushGraphicsState, scale } = globalThis.PDFLib;
const assets = new URL('./vendor/pdfjs/', import.meta.url);
GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.min.mjs', assets).href;
const jpegQuality = new Map([[150, 0.78], [110, 0.67], [96, 0.57], [72, 0.55]]);
const maxCanvasPixels = 18_000_000;
const maxCanvasEdge = 8192;

function viewportAtResolution(page, dpi) {
  const paper = page.getViewport({ scale: 1 });
  const factor = Math.min(
    dpi / 72,
    maxCanvasEdge / Math.max(paper.width, paper.height),
    Math.sqrt(maxCanvasPixels / (paper.width * paper.height))
  );
  return { paper, viewport: page.getViewport({ scale: factor }), actualDpi: Math.ceil(factor * 72) };
}

function monochromePixels(context, width, height, bilevel) {
  const { data } = context.getImageData(0, 0, width, height);
  let midtones = 0;
  let samples = 0;
  for (let i = 0; i < data.length; i += 13 * 4) {
    const red = data[i];
    if (Math.abs(red - data[i + 1]) > 5 || Math.abs(red - data[i + 2]) > 5) return;
    if (red > 28 && red < 227) midtones++;
    samples++;
  }
  if (midtones > samples * (bilevel ? 0.32 : 0.045)) return;

  const stride = Math.ceil(width / 8);
  const packed = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] > (bilevel ? 168 : 160)) packed[y * stride + (x >> 3)] |= 128 >> (x % 8);
    }
  }
  return packed;
}

async function addPage(document, canvas, context, paper, quality, bilevel) {
  const page = document.addPage([paper.width, paper.height]);
  const packed = monochromePixels(context, canvas.width, canvas.height, bilevel);
  if (packed) {
    const image = document.context.flateStream(packed, {
      Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceGray',
      BitsPerComponent: 1, Width: canvas.width, Height: canvas.height,
    });
    const name = page.node.newXObject('Scan', document.context.register(image));
    page.pushOperators(pushGraphicsState(), scale(paper.width, paper.height), drawObject(name), popGraphicsState());
    return;
  }

  const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!jpeg || jpeg.type !== 'image/jpeg') throw new Error('El navegador no pudo generar la imagen.');
  const image = await document.embedJpg(await jpeg.arrayBuffer());
  page.drawImage(image, { x: 0, y: 0, width: paper.width, height: paper.height });
  await image.embed();
}

export function createScanCompressor() {
  const worker = new PDFWorker();
  return {
    async compress(blob, dpi, signal, bilevel) {
      const quality = jpegQuality.get(dpi);
      if (!quality) throw new Error('Resolución inválida.');
      const data = new Uint8Array(await blob.arrayBuffer());
      signal.throwIfAborted();
      const loading = getDocument({
        data, worker, stopAtErrors: true, enableXfa: false,
        cMapPacked: true,
        cMapUrl: new URL('cmaps/', assets).href,
        standardFontDataUrl: new URL('standard_fonts/', assets).href,
        wasmUrl: new URL('wasm/', assets).href,
        iccUrl: new URL('iccs/', assets).href,
      });
      let rendering;
      const cancel = () => {
        rendering?.cancel();
        void loading.destroy().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const input = await loading.promise;
        const output = await PDFDocument.create();
        let actualDpi = 0;
        for (let number = 1; number <= input.numPages; number++) {
          signal.throwIfAborted();
          const page = await input.getPage(number);
          const { paper, viewport, actualDpi: pageDpi } = viewportAtResolution(page, dpi);
          actualDpi = Math.max(actualDpi, pageDpi);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
          try {
            signal.throwIfAborted();
            rendering = page.render({
              canvas, canvasContext: context, viewport,
              annotationMode: AnnotationMode.ENABLE, background: '#ffffff',
              transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
            });
            await rendering.promise;
            rendering = undefined;
            signal.throwIfAborted();
            await addPage(output, canvas, context, paper, quality, bilevel);
          } finally {
            canvas.width = canvas.height = 1;
            page.cleanup();
          }
        }

        signal.throwIfAborted();
        const bytes = await output.save({ addDefaultPage: false, useObjectStreams: true });
        if (bytes.length < blob.size) return { bytes, dpi: actualDpi };
        return {
          detail: 'Tamaño original',
          reason: 'Se probó la reducción de resolución, pero el PDF de origen pesa igual o menos.',
        };
      } finally {
        signal.removeEventListener('abort', cancel);
        await loading.destroy().catch(() => {});
      }
    },
    close() { worker.destroy(); },
  };
}
