'use strict';

const $ = id => document.getElementById(id);
const MiB = 1024 * 1024;
const filasPorPagina = 12;
const cola = [];
const lectores = [];
const formato = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 });
let pagina = 0;
let tarea;
let resultado;
let cargando = false;

function peso(bytes) {
  if (bytes >= MiB) return formato.format(bytes / MiB) + ' MB';
  if (bytes >= 1024) return formato.format(bytes / 1024) + ' KB';
  return bytes + ' B';
}

function aviso(mensaje = '') {
  $('avisos').textContent = mensaje;
  $('avisos').hidden = !mensaje;
}

function rutaSegura(nombre) {
  return nombre.replaceAll('\\', '/').split('/')
    .filter(p => p && p !== '.' && p !== '..')
    .map(p => {
      const limpio = p.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '_';
      return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(limpio) ? '_' + limpio : limpio;
    })
    .join('/');
}

function nombreUnico(nombre, usados) {
  const base = rutaSegura(nombre) || 'documento.pdf';
  let salida = base;
  for (let n = 2; usados.has(salida.normalize('NFC').toLowerCase()); n++) {
    salida = base.slice(0, -4) + ' (' + n + ')' + base.slice(-4);
  }
  usados.add(salida.normalize('NFC').toLowerCase());
  return salida;
}

function dibujar() {
  const paginas = Math.max(1, Math.ceil(cola.length / filasPorPagina));
  pagina = Math.max(0, Math.min(pagina, paginas - 1));
  $('resumen').textContent = cargando ? 'Leyendo archivos…' :
    cola.length ? formato.format(cola.length) + ' PDF en el lote' : 'Todavía no hay archivos.';
  $('elegir').disabled = cargando || !!tarea;
  $('comprimir').disabled = cargando || !!tarea || !cola.length || !window.zip || !!resultado?.guardando;
  $('nivel').disabled = !!tarea;
  $('vaciar').hidden = !cola.length || !!tarea || cargando;
  $('vaciar').disabled = !!resultado?.guardando;
  $('cancelar').hidden = !tarea;
  $('cancelar').disabled = tarea?.signal.aborted ?? false;
  $('paginas').hidden = paginas === 1;
  $('pagina').textContent = `${pagina + 1} de ${paginas}`;
  $('anterior').disabled = pagina === 0;
  $('siguiente').disabled = pagina === paginas - 1;

  const inicio = pagina * filasPorPagina;
  $('lista').replaceChildren(...cola.slice(inicio, inicio + filasPorPagina).map(item => {
    const li = document.createElement('li');
    const nombre = document.createElement('span');
    const estado = document.createElement('small');
    nombre.textContent = item.salida || item.nombre;
    estado.textContent = item.estado || peso(item.tamano);
    li.append(nombre, estado);
    return li;
  }));
}

function quitarResultado() {
  if (resultado) {
    const anterior = resultado;
    setTimeout(() => {
      URL.revokeObjectURL(anterior.url);
      void anterior.liberar?.();
    }, 60_000);
  }
  resultado = undefined;
  $('resultado').hidden = true;
  $('estado-descarga').textContent = '';
  $('descargar').removeAttribute('href');
  $('descarga-directa').removeAttribute('href');
}

async function agregar(archivos) {
  if (!archivos.length || tarea || cargando || resultado?.guardando) return;
  quitarResultado();
  aviso();
  $('estado').textContent = '';
  cargando = true;
  dibujar();

  const avisos = [];
  try {
    for (const archivo of archivos) {
      if (/\.pdf$/i.test(archivo.name)) {
        cola.push({ archivo, nombre: archivo.name, tamano: archivo.size });
      } else if (/\.zip$/i.test(archivo.name) && window.zip) {
        const lector = new zip.ZipReader(new zip.BlobReader(archivo), {
          useWebWorkers: false, strictness: 'balanced'
        });
        try {
          const entradas = (await lector.getEntries()).filter(entrada =>
            !entrada.directory && /\.pdf$/i.test(entrada.filename) &&
            !/(?:^|[\\/])(?:__MACOSX[\\/]|\._)/.test(entrada.filename)
          );
          if (!entradas.length) {
            avisos.push(`${archivo.name} no contiene PDF.`);
            await lector.close();
            continue;
          }
          lectores.push(lector);
          for (const entrada of entradas) {
            cola.push({ entrada, nombre: entrada.filename, tamano: entrada.uncompressedSize });
          }
        } catch {
          await lector.close().catch(() => {});
          avisos.push(`No se pudo abrir ${archivo.name}.`);
        }
      } else {
        avisos.push(`No se pudo agregar ${archivo.name}.`);
      }
    }
  } finally {
    cargando = false;
    aviso(avisos.slice(0, 4).join(' '));
    dibujar();
  }
}

async function temporal(tamano) {
  if (tamano < 96 * MiB || !navigator.storage?.getDirectory) return null;
  let directorio;
  const nombre = 'comprime-pdf-' + crypto.randomUUID() + '.tmp';
  try {
    directorio = await navigator.storage.getDirectory();
    const archivo = await directorio.getFileHandle(nombre, { create: true });
    const destino = (await archivo.createWritable()).getWriter();
    let cerrado = false;
    const stream = new WritableStream({
      write: bytes => destino.write(bytes),
      async close() { await destino.close(); cerrado = true; },
      async abort() { await destino.abort(); cerrado = true; }
    });
    return {
      stream,
      async finalizar() {
        if (!cerrado) await stream.close();
        return archivo.getFile();
      },
      async liberar() {
        if (!cerrado) await destino.abort().catch(() => {});
        await directorio.removeEntry(nombre).catch(() => {});
      }
    };
  } catch {
    await directorio?.removeEntry(nombre).catch(() => {});
    return null;
  }
}

async function abrirPDF(item, signal) {
  if (item.archivo) return { blob: item.archivo };
  const entrada = item.entrada;
  if (entrada.encrypted) throw new Error('ZIP con contraseña');
  if (!Number.isSafeInteger(item.tamano) || item.tamano < 0) throw new Error('Tamaño inválido');

  const disco = await temporal(item.tamano);
  try {
    if (!disco && item.tamano > 192 * MiB) throw new Error('PDF demasiado grande para la memoria disponible');
    const datos = await entrada.getData(disco?.stream ?? new zip.BlobWriter('application/pdf'), {
      signal, checkSignature: true, useWebWorkers: false
    });
    const blob = disco ? await disco.finalizar() : datos;
    if (blob.size !== item.tamano) throw new Error('PDF incompleto');
    return { blob, liberar: disco?.liberar };
  } catch (error) {
    await disco?.liberar();
    throw error;
  }
}

function motorPDF() {
  let worker;
  return {
    procesar(blob, nivel, signal) {
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        worker ??= new Worker('./pdf-worker.js');

        function terminar(datos, error, reiniciar) {
          clearTimeout(limite);
          signal.removeEventListener('abort', cancelar);
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          if (reiniciar) {
            worker.terminate();
            worker = null;
          }
          if (error) reject(error);
          else resolve(datos);
        }

        function cancelar() { terminar(null, signal.reason, true); }
        const limite = setTimeout(() => terminar({ nota: 'Original conservado' }, null, true), 75_000);
        signal.addEventListener('abort', cancelar, { once: true });
        worker.onmessage = ({ data }) => terminar(data);
        worker.onerror = worker.onmessageerror = () => {
          terminar(null, new Error('No se pudo iniciar el motor de PDF.'), true);
        };
        try { worker.postMessage({ blob, nivel }); }
        catch (error) { terminar(null, error, true); }
      });
    },
    cerrar() { worker?.terminate(); }
  };
}

async function comprimir() {
  if (!cola.length || tarea || cargando || resultado?.guardando) return;
  quitarResultado();
  aviso();
  tarea = new AbortController();
  const { signal } = tarea;
  const nivel = $('nivel').value;
  const motor = motorPDF();
  const usados = new Set();
  let disco;
  let incluidos = 0;
  let omitidos = 0;
  let ahorro = 0;

  for (const item of cola) {
    delete item.estado;
    delete item.salida;
  }

  $('progreso').value = 0;
  $('progreso').hidden = false;
  $('estado').textContent = 'Preparando el lote…';
  dibujar();

  try {
    const total = cola.reduce((suma, item) => suma + item.tamano, 0);
    disco = await temporal(total);
    const escritor = new zip.ZipWriter(disco?.stream ?? new zip.BlobWriter('application/zip'), {
      level: 0, useWebWorkers: false
    });

    for (const [i, item] of cola.entries()) {
      signal.throwIfAborted();
      let entrada;
      try {
        entrada = await abrirPDF(item, signal);
      } catch (error) {
        signal.throwIfAborted();
        item.estado = 'Omitido · ' + (item.entrada?.encrypted ? 'ZIP protegido' : 'No se pudo leer');
        omitidos++;
      }

      if (entrada) {
        try {
          const respuesta = await motor.procesar(entrada.blob, nivel, signal);
          const salida = respuesta.bytes
            ? new Blob([respuesta.bytes], { type: 'application/pdf' })
            : entrada.blob;
          const nombre = nombreUnico(item.nombre, usados);
          await escritor.add(nombre, new zip.BlobReader(salida), { signal });
          item.salida = nombre;
          item.estado = respuesta.bytes ? peso(entrada.blob.size) + ' → ' + peso(salida.size) : respuesta.nota;
          ahorro += entrada.blob.size - salida.size;
          incluidos++;
        } finally {
          await entrada.liberar?.();
        }
      }

      $('progreso').value = Math.floor((i + 1) / cola.length * 99);
      $('estado').textContent = `${i + 1} de ${cola.length} PDF procesados`;
      if (i % 8 === 0) dibujar();
    }

    signal.throwIfAborted();
    if (!incluidos) throw new Error('El lote no contiene PDF que se puedan incluir.');
    const datos = await escritor.close();
    const blob = disco ? await disco.finalizar() : datos;
    signal.throwIfAborted();
    if (!blob?.size) throw new Error('El ZIP quedó vacío.');

    resultado = { blob, url: URL.createObjectURL(blob), liberar: disco?.liberar };
    disco = undefined;
    $('descargar').href = resultado.url;
    $('descarga-directa').href = resultado.url;
    $('descarga-directa').hidden = !window.showSaveFilePicker;
    $('detalle').textContent = `${incluidos} PDF · ${peso(blob.size)} de ZIP · ${peso(ahorro)} de ahorro`;
    $('resultado').hidden = false;
    $('estado').textContent = 'Compresión terminada.';
    if (omitidos) aviso(`${omitidos} PDF omitidos. Revisa el estado de la cola.`);
  } catch (error) {
    $('estado').textContent = signal.aborted ? 'Compresión cancelada.' : '';
    if (!signal.aborted) {
      aviso(error.name === 'QuotaExceededError'
        ? 'No queda espacio suficiente. Divide el lote o libera almacenamiento.'
        : error.message || 'No se pudo generar el ZIP.');
    }
  } finally {
    await disco?.liberar();
    motor.cerrar();
    tarea = undefined;
    $('progreso').hidden = true;
    dibujar();
  }
}

async function guardarZIP(evento) {
  if (!resultado || !window.showSaveFilePicker) return;
  evento.preventDefault();
  const actual = resultado;
  if (actual.guardando) return;
  actual.guardando = true;
  dibujar();

  try {
    const destino = await window.showSaveFilePicker({
      suggestedName: 'PDF-comprimidos.zip',
      types: [{ description: 'Archivo ZIP', accept: { 'application/zip': ['.zip'] } }]
    });
    await actual.blob.stream().pipeTo(await destino.createWritable());
    $('estado-descarga').textContent = 'ZIP guardado correctamente.';
  } catch (error) {
    if (error.name !== 'AbortError') {
      $('estado-descarga').textContent = 'Usa «Descarga directa» para guardar el ZIP.';
      $('descarga-directa').hidden = false;
    }
  } finally {
    actual.guardando = false;
    dibujar();
  }
}

$('elegir').onclick = () => $('archivos').click();
$('archivos').onchange = () => {
  const archivos = [...$('archivos').files];
  $('archivos').value = '';
  void agregar(archivos);
};
$('zona').ondragover = e => {
  e.preventDefault();
  $('zona').classList.add('arrastrando');
};
$('zona').ondragleave = () => $('zona').classList.remove('arrastrando');
$('zona').ondrop = e => {
  e.preventDefault();
  $('zona').classList.remove('arrastrando');
  void agregar([...e.dataTransfer.files]);
};
document.addEventListener('dragover', e => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', e => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});

$('comprimir').onclick = comprimir;
$('cancelar').onclick = () => { tarea?.abort(); dibujar(); };
$('descargar').addEventListener('click', guardarZIP);
$('anterior').onclick = () => { pagina--; dibujar(); };
$('siguiente').onclick = () => { pagina++; dibujar(); };
$('vaciar').onclick = () => {
  if (tarea || cargando || resultado?.guardando) return;
  quitarResultado();
  for (const lector of lectores.splice(0)) void lector.close().catch(() => {});
  cola.length = 0;
  $('estado').textContent = '';
  aviso();
  dibujar();
};

if (!window.zip) aviso('No se pudo cargar la biblioteca ZIP. Revisa tu conexión y recarga la página.');
dibujar();
