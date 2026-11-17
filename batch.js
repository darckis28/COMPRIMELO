'use strict';

globalThis.PdfBatch = (() => {
  const { BlobReader, BlobWriter, ZipReader, ZipWriter } = zip;
  const largeBatchBytes = 96 * 1024 * 1024;
  const methodLimit = 192 * 1024 * 1024;

  function safePath(name) {
    return name.replaceAll('\\', '/').split('/')
      .filter(part => part && part !== '.' && part !== '..')
      .map(part => {
        const clean = part.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '') || '_';
        return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? '_' + clean : clean;
      })
      .join('/');
  }

  function uniquePaths() {
    const files = new Set();
    const folders = new Set();
    const indexes = new Map();
    const directoryAliases = new Map();
    const normalize = value => value.normalize('NFC').toLowerCase();

    return (path) => {
      const parts = safePath(path).split('/');
      const filename = parts.pop();
      let directory = '';
      for (const part of parts) {
        const base = directory + part;
        const key = normalize(base);
        let candidate = directoryAliases.get(key) ?? base;
        for (let suffix = 2; files.has(normalize(candidate)); suffix++) {
          candidate = base + ' (' + suffix + ')';
        }
        directoryAliases.set(key, candidate);
        folders.add(normalize(candidate));
        directory = candidate + '/';
      }

      const base = directory + filename;
      const key = normalize(base);
      let candidate = base;
      let suffix = indexes.get(key) ?? 2;
      while (files.has(normalize(candidate)) || folders.has(normalize(candidate))) {
        candidate = base.slice(0, -4) + ' (' + suffix++ + ')' + base.slice(-4);
      }
      indexes.set(key, suffix);
      files.add(normalize(candidate));
      return candidate;
    };
  }

  async function getArchive(file) {
    const archive = new ZipReader(new BlobReader(file), { useWebWorkers: false, strictness: 'balanced' });
    try {
      const entries = await archive.getEntries();
      return {
        entries: entries.filter(entry => !entry.directory &&
          !entry.filename.replaceAll('\\', '/').split('/').some(part => part === '__MACOSX' || part.startsWith('._')) &&
          /\.pdf$/i.test(entry.filename)),
        close: () => archive.close(),
      };
    } catch (error) {
      await archive.close().catch(() => {});
      throw error;
    }
  }

  async function extractFile(item, signal) {
    if (item.file) return item.file;
    const entry = item.entry;
    if (entry.encrypted) throw new Error('PDF dentro de un ZIP con contraseña.');
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new Error('El tamaño registrado en el ZIP es inválido.');
    }
    const options = { checkSignature: true, useWebWorkers: false, signal };
    const temporary = await diskFile(entry.uncompressedSize);
    try {
      let blob;
      if (temporary) {
        await entry.getData(temporary.stream, options);
        if (!temporary.closed()) await temporary.stream.close();
        blob = await temporary.getBlob();
      } else {
        if (entry.uncompressedSize > methodLimit) throw new Error('El navegador no pudo reservar almacenamiento para este PDF del ZIP.');
        blob = await entry.getData(new BlobWriter('application/pdf'), options);
      }
      if (blob.size !== entry.uncompressedSize) throw new Error('El PDF extraído está incompleto.');
      return { blob, release: () => temporary?.release() };
    } catch (error) {
      await temporary?.release();
      throw error;
    }
  }

  async function diskFile(bytes, force = false) {
    if ((!force && bytes <= largeBatchBytes) || !navigator.storage?.getDirectory) return null;
    let directory;
    const id = crypto.randomUUID();
    const name = 'compresion-' + id + '.tmp';
    try {
      const storage = await navigator.storage.getDirectory();
      directory = await storage.getDirectoryHandle('comprime-pdf', { create: true });
      const handle = await directory.getFileHandle(name, { create: true });
      const stream = await handle.createWritable();
      let closed = false;
      let writer;
      const output = new WritableStream({
        start() { writer = stream.getWriter(); },
        write(data) { return writer.write(data); },
        async close() { await writer.close(); closed = true; },
        async abort(reason) { await writer.abort(reason); closed = true; },
      });
      return {
        stream: output,
        id,
        closed: () => closed,
        getBlob: () => handle.getFile(),
        async release() {
          if (!closed) await writer.abort().catch(() => {});
          await directory.removeEntry(name).catch(() => {});
        },
      };
    } catch {
      await directory?.removeEntry(name).catch(() => {});
      return null;
    }
  }

  async function outputZip(bytes, localDownload) {
    const temporary = await diskFile(bytes, localDownload);
    const writer = new ZipWriter(
      temporary?.stream ?? new BlobWriter('application/zip'),
      { useWebWorkers: false, level: 0 }
    );
    return {
      downloadId: localDownload ? temporary?.id : undefined,
      add: (path, blob, signal) => writer.add(path, new BlobReader(blob), { signal }),
      async finish() {
        const result = await writer.close();
        if (!temporary) return result;
        if (!temporary.closed()) await temporary.stream.close();
        return temporary.getBlob();
      },
      release: () => temporary?.release(),
    };
  }

  function pdfProcessor() {
    let worker;
    return {
      convert(blob, mode, signal) {
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          try { worker ??= new Worker('./pdf-worker.js'); }
          catch { return resolve({ detail: 'Motor no disponible' }); }

          function finish(response, error, reset = false) {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            if (reset) {
              worker.terminate();
              worker = null;
            }
            if (error) reject(error);
            else resolve(response);
          }

          function abort() { finish(null, signal.reason, true); }
          const timer = setTimeout(() => finish({ detail: 'Tiempo agotado' }, null, true), 75_000);
          signal.addEventListener('abort', abort, { once: true });
          worker.onmessage = event => finish(event.data);
          worker.onerror = worker.onmessageerror = () => finish({ detail: 'Error de procesamiento' }, null, true);
          try { worker.postMessage({ blob, mode }); }
          catch { finish({ detail: 'Error de procesamiento' }, null, true); }
        });
      },
      close() { worker?.terminate(); worker = null; },
    };
  }

  async function process(items, mode, signal, progress, dpi, localDownload = false) {
    const processor = pdfProcessor();
    let archive;
    let scanCompressor;
    try {
      archive = await outputZip(items.reduce((total, item) => total + item.size, 0), localDownload);
      const allocatePath = uniquePaths();
      const totals = { input: 0, output: 0, included: 0, errors: 0, originals: 0 };
      for (const [index, item] of items.entries()) {
        signal.throwIfAborted();
        item.status = 'working';
        progress(index, items.length);
        let input;
        try {
          input = await extractFile(item, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error?.name === 'QuotaExceededError') throw error;
          item.status = 'error';
          if (item.entry?.encrypted) {
            item.reason = 'PDF dentro de un ZIP con contraseña.';
          } else if (error.message === 'El navegador no pudo reservar almacenamiento para este PDF del ZIP.') {
            item.reason = error.message;
          } else {
            item.reason = 'No se pudo leer el PDF dentro del ZIP.';
          }
          totals.errors++;
          progress(index + 1, items.length);
          continue;
        }

        try {
          const blob = input.blob ?? input;
          let result = await processor.convert(blob, mode, signal);
          if (result.rasterize) {
            try {
              if (!scanCompressor) scanCompressor = (await import('./scan.mjs')).createScanCompressor();
              signal.throwIfAborted();
              result = await scanCompressor.compress(blob, dpi, signal, result.bilevel);
            } catch {
              signal.throwIfAborted();
              result = {
                detail: 'Escaneo sin cambios',
                reason: 'El navegador no pudo convertir este PDF a imágenes. Se incluyó el original.',
              };
            }
          }
          signal.throwIfAborted();
          const output = result.bytes ? new Blob([result.bytes], { type: 'application/pdf' }) : blob;
          const path = allocatePath(item.name);
          // ZIP entries use storage mode because each PDF has already been optimized.
          await archive.add(path, output, signal);
          item.outputName = path;
          item.outputSize = output.size;
          item.status = result.bytes ? 'compressed' : 'original';
          item.detail = result.detail;
          item.dpi = result.dpi;
          item.reason = result.reason;
          totals.input += blob.size;
          totals.output += output.size;
          totals.included++;
          if (!result.bytes) totals.originals++;
        } finally {
          await input.release?.();
        }
        progress(index + 1, items.length);
      }

      signal.throwIfAborted();
      if (!totals.included) {
        await archive.release();
        return { ...totals, blob: null };
      }
      const blob = await archive.finish();
      signal.throwIfAborted();
      return { ...totals, blob, downloadId: archive.downloadId, release: archive.release };
    } catch (error) {
      await archive?.release();
      throw error;
    } finally {
      processor.close();
      scanCompressor?.close();
    }
  }

  return { getArchive, process, safePath };
})();
