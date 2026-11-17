'use strict';

const byId = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const items = [];
const archives = [];
const notices = [];
const pageSize = 12;
const format = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 });
let page = 0;
let importing = false;
let job = null;
let nextID = 0;
let completed;
let objectURL;
let dragDepth = 0;
let progressFrame = null;

const elements = {};
for (const id of [
  'dropzone', 'choose', 'files', 'notices', 'count', 'queue-summary', 'clear', 'empty', 'queue',
  'pagination', 'prev', 'next', 'page-indicator', 'profiles', 'start', 'cancel', 'progress-wrap',
  'progress-text', 'progress-percent', 'progress', 'result', 'result-summary', 'download-link', 'announcement',
  'resolution-options', 'resolution',
]) elements[id] = byId(id);

function labelBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let level = 0;
  while (value >= 1024 && level < units.length - 1) {
    value /= 1024;
    level++;
  }
  return format.format(value) + ' ' + units[level];
}

function icon(name) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}

function element(tag, classes, label) {
  const node = document.createElement(tag);
  if (classes) node.className = classes;
  if (label !== undefined) node.textContent = label;
  return node;
}

function describeStatus(item) {
  const size = item.size;
  switch (item.status) {
    case 'working': return ['Procesando', ''];
    case 'compressed': {
      const reduction = size ? (size - item.outputSize) / size * 100 : 0;
      return ['−' + format.format(reduction) + ' %', 'success'];
    }
    case 'original': return [item.detail ?? 'Original', item.detail === 'Tamaño original' ? '' : 'warning'];
    case 'error': return ['No incluido', 'warning'];
    default: return ['En espera', ''];
  }
}

function fileRow(item) {
  const row = element('li');
  const fileIcon = element('span', 'file-icon');
  fileIcon.append(icon('file'));
  const metadata = element('div');
  const name = element('span', 'file-name', item.outputName ?? item.name);
  name.title = item.outputName ?? item.name;
  const sizes = item.status === 'compressed' ? labelBytes(item.size) + ' → ' + labelBytes(item.outputSize) : labelBytes(item.size);
  const notes = item.dpi ? item.dpi + ' ppp' : item.reason;
  const info = element('span', 'file-size', sizes + (notes ? ' · ' + notes : ''));
  metadata.append(name, info);
  const [text, variant] = describeStatus(item);
  const status = element('span', 'file-state ' + variant, text);
  if (item.reason) status.title = item.reason;
  row.append(fileIcon, metadata, status);
  if (!job && !importing) {
    const remove = element('button', 'remove-file');
    remove.type = 'button';
    remove.dataset.remove = String(item.id);
    remove.setAttribute('aria-label', 'Quitar ' + item.name);
    remove.append(icon('close'));
    row.append(remove);
  }
  return row;
}

function renderQueue() {
  const count = items.length;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  page = Math.max(0, Math.min(page, pages - 1));
  elements.count.textContent = format.format(count);
  const size = items.reduce((total, item) => total + item.size, 0);
  elements['queue-summary'].textContent = count
    ? format.format(count) + ' PDF' + ' · ' + labelBytes(size) + ' en total'
    : 'Aquí verás tus documentos y su estado.';
  if (importing) elements['queue-summary'].textContent = 'Leyendo archivos…';

  const offset = page * pageSize;
  elements.queue.replaceChildren(...items.slice(offset, offset + pageSize).map(fileRow));
  elements.queue.hidden = !count;
  elements.empty.hidden = !!count;
  elements.clear.hidden = !count || !!job || importing;
  elements.pagination.hidden = pages === 1;
  elements.prev.disabled = page === 0;
  elements.next.disabled = page === pages - 1;
  elements['page-indicator'].textContent = 'Página ' + (page + 1) + ' de ' + pages;
}

function renderControls() {
  elements.choose.disabled = !!job || importing;
  elements.start.disabled = !items.length || !!job || importing;
  elements.profiles.disabled = !!job;
  elements['resolution-options'].hidden = elements.profiles.querySelector('input:checked').value !== 'resolution';
  elements.cancel.hidden = !job;
  elements.cancel.disabled = job?.signal.aborted ?? false;
}

function renderNotices() {
  elements.notices.hidden = !notices.length;
  const list = element('ul');
  for (const notice of notices.slice(0, 5)) list.append(element('li', '', notice));
  if (notices.length > 5) list.append(element('li', '', 'Y ' + (notices.length - 5) + ' avisos más.'));
  elements.notices.replaceChildren(list);
}

function refresh() {
  renderControls();
  renderQueue();
  renderNotices();
}

function say(message) {
  elements.announcement.textContent = message;
}

function clearResult() {
  if (completed?.blob) {
    const url = objectURL;
    const result = completed;
    // Give browser downloads time to open the Blob before releasing storage.
    setTimeout(() => {
      if (url) URL.revokeObjectURL(url);
      void result?.release?.();
    }, 60_000);
  }
  completed = undefined;
  objectURL = undefined;
  elements.result.hidden = true;
  elements['download-link'].removeAttribute('href');
  elements['progress-wrap'].hidden = true;
}

function resetStatuses() {
  for (const item of items) {
    item.status = undefined;
    item.outputSize = undefined;
    item.outputName = undefined;
    item.detail = undefined;
    item.dpi = undefined;
    item.reason = undefined;
  }
}

function archiveMessage(file) {
  return 'No se pudo abrir «' + file.name + '». Verifica que sea un ZIP válido.';
}

async function addFiles(files) {
  if (!files.length || job || importing) return;
  clearResult();
  resetStatuses();
  importing = true;
  notices.length = 0;
  refresh();
  let ignored = 0;
  let added = 0;
  try {
    for (const file of files) {
      if (/\.pdf$/i.test(file.name)) {
        items.push({ id: nextID++, name: PdfBatch.safePath(file.name), size: file.size, file });
        added++;
      } else if (/\.zip$/i.test(file.name)) {
        try {
          const archive = await PdfBatch.getArchive(file);
          if (!archive.entries.length) {
            await archive.close();
            notices.push('El ZIP «' + file.name + '» no contiene PDF.');
          } else {
            archives.push(archive);
            for (const entry of archive.entries) {
              items.push({
                id: nextID++, name: PdfBatch.safePath(entry.filename),
                size: Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0 ? entry.uncompressedSize : 0,
                entry,
              });
              added++;
            }
          }
        } catch {
          notices.push(archiveMessage(file));
        }
      } else ignored++;
    }
    if (ignored) notices.push(ignored === 1 ? 'Se omitió un archivo porque solo se admiten PDF y ZIP.' :
      'Se omitieron ' + ignored + ' archivos porque solo se admiten PDF y ZIP.');
  } finally {
    importing = false;
    if (added && items.length === added) page = 0;
    refresh();
    if (added) say(added === 1 ? 'Se agregó 1 PDF.' : 'Se agregaron ' + added + ' PDF.');
  }
}

function updateProgress(done, total) {
  const percent = Math.min(99, Math.floor(done / total * 100));
  elements.progress.value = percent;
  elements['progress-percent'].textContent = percent + ' %';
  elements['progress-text'].textContent = done === total
    ? 'Preparando la descarga…' : format.format(done) + ' de ' + format.format(total) + ' PDF procesados';
  if (progressFrame === null) {
    progressFrame = requestAnimationFrame(() => {
      progressFrame = null;
      renderQueue();
    });
  }
}

function setZipLink(blob) {
  const zip = blob.type === 'application/zip' ? blob : blob.slice(0, blob.size, 'application/zip');
  objectURL = URL.createObjectURL(zip);
  elements['download-link'].href = objectURL;
}

async function run() {
  if (!items.length || importing || job) return;
  clearResult();
  resetStatuses();
  notices.length = 0;
  job = new AbortController();
  const { signal } = job;
  elements['progress-wrap'].hidden = false;
  const mode = elements.profiles.querySelector('input:checked').value;
  updateProgress(0, items.length);
  refresh();
  say('Compresión iniciada.');
  try {
    completed = await PdfBatch.process(
      items, mode, signal, updateProgress, Number(elements.resolution.value)
    );
    if (!completed.blob) {
      notices.push('No se pudo incluir ningún PDF. Revisa el estado de los archivos en la cola.');
      say(notices[notices.length - 1]);
      return;
    }
    setZipLink(completed.blob);
    const savings = completed.input - completed.output;
    const percentage = completed.input ? (savings / completed.input) * 100 : 0;
    const parts = [
      format.format(completed.included) + (completed.included === 1 ? ' PDF incluido' : ' PDF incluidos'),
      labelBytes(completed.blob.size) + ' de ZIP',
    ];
    if (savings) parts.push(format.format(percentage) + ' % menos en los PDF');
    if (completed.originals) parts.push(format.format(completed.originals) + (completed.originals === 1 ? ' original conservado' : ' originales conservados'));
    elements['result-summary'].textContent = parts.join(' · ');
    elements.result.hidden = false;
    if (completed.errors) notices.push('Hay archivos que no se pudieron incluir. Revisa los marcados en la cola.');
    elements.progress.value = 100;
    say('ZIP listo para descargar. ' + parts.join('. ') + '.');
  } catch (error) {
    if (signal.aborted) {
      resetStatuses();
      say('Compresión cancelada.');
    } else {
      notices.push(error?.name === 'QuotaExceededError'
        ? 'El navegador se quedó sin espacio. Libera almacenamiento o divide el lote.'
        : 'El navegador no pudo generar el ZIP. Intenta procesar un lote más pequeño.');
      say(notices[notices.length - 1]);
    }
  } finally {
    job = null;
    elements['progress-wrap'].hidden = true;
    refresh();
  }
}

elements.choose.addEventListener('click', () => elements.files.click());
elements.files.addEventListener('change', () => {
  const files = Array.from(elements.files.files);
  elements.files.value = '';
  void addFiles(files);
});

function hasFiles(event) {
  return event.dataTransfer?.types.includes('Files');
}

document.addEventListener('dragover', event => {
  if (hasFiles(event)) event.preventDefault();
});
document.addEventListener('drop', event => {
  if (hasFiles(event)) event.preventDefault();
});
elements.dropzone.addEventListener('dragenter', event => {
  if (!hasFiles(event) || job || importing) return;
  event.preventDefault();
  dragDepth++;
  elements.dropzone.classList.add('dragging');
});
elements.dropzone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) elements.dropzone.classList.remove('dragging');
});
elements.dropzone.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  elements.dropzone.classList.remove('dragging');
  void addFiles(Array.from(event.dataTransfer.files));
});

elements.start.addEventListener('click', () => void run());
elements.cancel.addEventListener('click', () => {
  job?.abort();
  renderControls();
});
elements.clear.addEventListener('click', () => {
  if (job || importing) return;
  clearResult();
  for (const archive of archives.splice(0)) void archive.close().catch(() => {});
  items.length = 0;
  notices.length = 0;
  refresh();
  elements.choose.focus();
});
elements.queue.addEventListener('click', event => {
  const button = event.target.closest('button[data-remove]');
  if (!button || job || importing) return;
  const index = items.findIndex(item => item.id === Number(button.dataset.remove));
  if (index < 0) return;
  items.splice(index, 1);
  clearResult();
  resetStatuses();
  refresh();
  const buttons = elements.queue.querySelectorAll('button[data-remove]');
  (buttons[Math.min(index % pageSize, buttons.length - 1)] ?? elements.choose).focus();
});
elements.prev.addEventListener('click', () => { page--; renderQueue(); });
elements.next.addEventListener('click', () => { page++; renderQueue(); });
elements.profiles.addEventListener('change', () => {
  if (completed) {
    clearResult();
    resetStatuses();
  }
  refresh();
});
refresh();
