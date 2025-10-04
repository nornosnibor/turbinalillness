const canvasWidthInput = document.getElementById('canvas-width');
const canvasHeightInput = document.getElementById('canvas-height');
const canvasBackgroundInput = document.getElementById('canvas-background');
const canvasGridSelect = document.getElementById('canvas-grid');
const shapeForm = document.getElementById('shape-form');
const shapeTypeSelect = document.getElementById('shape-type');
const shapeFieldsContainer = document.getElementById('shape-fields');
const shapeList = document.getElementById('shape-list');
const previewWrap = document.getElementById('preview-wrap');
const codeOutput = document.getElementById('code-output');
const clearShapesBtn = document.getElementById('clear-shapes');
const copyCodeBtn = document.getElementById('copy-code');
const downloadBtn = document.getElementById('download-svg');
const toast = document.getElementById('toast');
const editDialog = document.getElementById('edit-dialog');
const editFieldsContainer = document.getElementById('edit-fields');
const templateRow = document.getElementById('shape-row-template');
const parser = new DOMParser();

const state = {
  width: 600,
  height: 400,
  background: '#0f172a',
  grid: 'none',
  shapes: [],
};

const SHAPE_DEFS = {
  rectangle: {
    label: 'Rectangle',
    summary: ({ x, y, width, height }) => `Rect • x${x}, y${y}, ${width}×${height}`,
    fields: [
      { name: 'x', label: 'X', type: 'number', min: 0, value: 32 },
      { name: 'y', label: 'Y', type: 'number', min: 0, value: 32 },
      { name: 'width', label: 'Width', type: 'number', min: 1, value: 160 },
      { name: 'height', label: 'Height', type: 'number', min: 1, value: 120 },
      { name: 'rx', label: 'Radius X', type: 'number', min: 0, value: 12 },
      { name: 'ry', label: 'Radius Y', type: 'number', min: 0, value: 12 },
      { name: 'fill', label: 'Fill', type: 'color', value: '#6366f1' },
      { name: 'stroke', label: 'Stroke', type: 'color', value: '#1e293b' },
      { name: 'strokeWidth', label: 'Stroke W', type: 'number', min: 0, step: 0.5, value: 2 },
    ],
  },
  circle: {
    label: 'Circle',
    summary: ({ cx, cy, r }) => `Circle • c${cx},${cy} r${r}`,
    fields: [
      { name: 'cx', label: 'Center X', type: 'number', min: 0, value: 220 },
      { name: 'cy', label: 'Center Y', type: 'number', min: 0, value: 140 },
      { name: 'r', label: 'Radius', type: 'number', min: 1, value: 70 },
      { name: 'fill', label: 'Fill', type: 'color', value: '#f472b6' },
      { name: 'stroke', label: 'Stroke', type: 'color', value: '#0f172a' },
      { name: 'strokeWidth', label: 'Stroke W', type: 'number', min: 0, step: 0.5, value: 8 },
      { name: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.1, value: 0.85 },
    ],
  },
  ellipse: {
    label: 'Ellipse',
    summary: ({ cx, cy, rx, ry }) => `Ellipse • c${cx},${cy} rx${rx} ry${ry}`,
    fields: [
      { name: 'cx', label: 'Center X', type: 'number', value: 320 },
      { name: 'cy', label: 'Center Y', type: 'number', value: 180 },
      { name: 'rx', label: 'Radius X', type: 'number', value: 140 },
      { name: 'ry', label: 'Radius Y', type: 'number', value: 60 },
      { name: 'fill', label: 'Fill', type: 'color', value: '#22d3ee' },
      { name: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.1, value: 0.6 },
    ],
  },
  line: {
    label: 'Line',
    summary: ({ x1, y1, x2, y2 }) => `Line • (${x1},${y1}) → (${x2},${y2})`,
    fields: [
      { name: 'x1', label: 'X1', type: 'number', value: 80 },
      { name: 'y1', label: 'Y1', type: 'number', value: 80 },
      { name: 'x2', label: 'X2', type: 'number', value: 340 },
      { name: 'y2', label: 'Y2', type: 'number', value: 220 },
      { name: 'stroke', label: 'Stroke', type: 'color', value: '#38bdf8' },
      { name: 'strokeWidth', label: 'Stroke W', type: 'number', min: 0, value: 6 },
      { name: 'strokeLinecap', label: 'Line Cap', type: 'select', value: 'round', options: ['round', 'butt', 'square'] },
      { name: 'strokeDasharray', label: 'Dasharray', type: 'text', placeholder: 'e.g. 12 6' },
    ],
  },
  polygon: {
    label: 'Polygon',
    summary: ({ points }) => `Polygon • ${points}`,
    fields: [
      {
        name: 'points',
        label: 'Points',
        type: 'textarea',
        placeholder: '40,160 120,40 220,160',
        rows: 2,
        value: '80,280 180,160 320,240 400,120',
      },
      { name: 'fill', label: 'Fill', type: 'color', value: '#22c55e' },
      { name: 'stroke', label: 'Stroke', type: 'color', value: '#052e16' },
      { name: 'strokeWidth', label: 'Stroke W', type: 'number', min: 0, value: 4 },
      { name: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.1, value: 0.7 },
    ],
  },
  text: {
    label: 'Text',
    summary: ({ content, x, y }) => `Text • "${content}" @ ${x},${y}`,
    fields: [
      { name: 'content', label: 'Content', type: 'text', value: 'SVG' },
      { name: 'x', label: 'X', type: 'number', value: 120 },
      { name: 'y', label: 'Y', type: 'number', value: 260 },
      { name: 'fontSize', label: 'Font size', type: 'number', value: 64 },
      { name: 'fontFamily', label: 'Font family', type: 'text', value: '"Inter", sans-serif' },
      { name: 'fill', label: 'Fill', type: 'color', value: '#f8fafc' },
      { name: 'fontWeight', label: 'Weight', type: 'select', value: '700', options: ['400', '500', '600', '700', '800'] },
      { name: 'letterSpacing', label: 'Letter spacing', type: 'text', placeholder: 'e.g. 4px' },
    ],
  },
};

function createField(def, prefix = '') {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const span = document.createElement('span');
  span.textContent = def.label;
  wrapper.appendChild(span);

  let input;
  if (def.type === 'select') {
    input = document.createElement('select');
    def.options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      input.appendChild(option);
    });
    input.value = def.value ?? '';
  } else if (def.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = def.rows || 3;
    if (def.placeholder) input.placeholder = def.placeholder;
    input.value = def.value ?? '';
  } else {
    input = document.createElement('input');
    input.type = def.type || 'text';
    if (def.placeholder) input.placeholder = def.placeholder;
    if (typeof def.min !== 'undefined') input.min = def.min;
    if (typeof def.max !== 'undefined') input.max = def.max;
    if (typeof def.step !== 'undefined') input.step = def.step;
    input.value = def.value ?? '';
  }

  input.name = prefix + def.name;
  wrapper.appendChild(input);
  return wrapper;
}

function renderShapeFields(target, type, values = {}) {
  const def = SHAPE_DEFS[type];
  target.innerHTML = '';
  if (!def) return;
  def.fields.forEach((field) => {
    const fieldEl = createField(field);
    const input = fieldEl.querySelector('input, select, textarea');
    if (values[field.name] != null) {
      input.value = values[field.name];
    }
    target.appendChild(fieldEl);
  });
}

function formValues(container) {
  const data = {};
  container.querySelectorAll('input, select, textarea').forEach((input) => {
    if (input.type === 'number') {
      const value = input.value.trim();
      data[input.name] = value === '' ? '' : Number(value);
    } else {
      data[input.name] = input.value;
    }
  });
  return data;
}

function sanitizeShape(type, values) {
  const def = SHAPE_DEFS[type];
  if (!def) return null;
  const sanitized = { type };
  def.fields.forEach((field) => {
    let value = values[field.name];
    if (value === '' || value == null) return;
    if (field.type === 'number') {
      value = Number(value);
      if (Number.isNaN(value)) return;
    }
    sanitized[field.name] = value;
  });
  return sanitized;
}

function shapeToMarkup(shape) {
  if (!shape) return '';
  const { type, ...attrs } = shape;
  switch (type) {
    case 'rectangle': {
      const { x = 0, y = 0, width = 100, height = 100, rx, ry, fill, stroke, strokeWidth } = attrs;
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}"${attr('rx', rx)}${attr('ry', ry)}${attr(
        'fill',
        fill
      )}${attr('stroke', stroke)}${attr('stroke-width', strokeWidth)} />`;
    }
    case 'circle': {
      const { cx = 0, cy = 0, r = 50, fill, stroke, strokeWidth, opacity } = attrs;
      return `<circle cx="${cx}" cy="${cy}" r="${r}"${attr('fill', fill)}${attr('stroke', stroke)}${attr(
        'stroke-width',
        strokeWidth
      )}${attr('opacity', opacity)} />`;
    }
    case 'ellipse': {
      const { cx = 0, cy = 0, rx = 50, ry = 50, fill, opacity } = attrs;
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${attr('fill', fill)}${attr('opacity', opacity)} />`;
    }
    case 'line': {
      const { x1 = 0, y1 = 0, x2 = 100, y2 = 100, stroke, strokeWidth, strokeLinecap, strokeDasharray } = attrs;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${attr('stroke', stroke)}${attr(
        'stroke-width',
        strokeWidth
      )}${attr('stroke-linecap', strokeLinecap)}${attr('stroke-dasharray', strokeDasharray)} />`;
    }
    case 'polygon': {
      const { points = '', fill, stroke, strokeWidth, opacity } = attrs;
      return `<polygon points="${points}"${attr('fill', fill)}${attr('stroke', stroke)}${attr('stroke-width', strokeWidth)}${attr(
        'opacity',
        opacity
      )} />`;
    }
    case 'text': {
      const { content = '', x = 0, y = 0, fontSize, fontFamily, fill, fontWeight, letterSpacing } = attrs;
      return `<text x="${x}" y="${y}"${attr('font-size', fontSize)}${attr('font-family', fontFamily)}${attr(
        'fill',
        fill
      )}${attr('font-weight', fontWeight)}${attr('letter-spacing', letterSpacing)}>${escapeHtml(content)}</text>`;
    }
    default:
      return '';
  }
}

function attr(name, value) {
  if (value == null || value === '') return '';
  return ` ${name}="${value}"`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildSvgMarkup() {
  const { width, height, background, shapes } = state;
  const viewBox = `0 0 ${width} ${height}`;
  const shapeMarkup = shapes.map((shape) => shapeToMarkup(shape)).join('\n  ');
  const backgroundRect = `<rect width="100%" height="100%" fill="${background}" />`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" role="img">\n  ${backgroundRect}${shapeMarkup ? `\n  ${shapeMarkup}` : ''}\n</svg>`;
}

function render() {
  const markup = buildSvgMarkup();
  codeOutput.value = markup;

  const doc = parser.parseFromString(markup, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  previewWrap.innerHTML = '';
  if (svgEl) {
    const adopted = document.importNode(svgEl, true);
    previewWrap.appendChild(adopted);
  } else {
    const error = document.createElement('p');
    error.textContent = 'Could not render SVG markup.';
    previewWrap.appendChild(error);
  }

  previewWrap.dataset.grid = state.grid;
  renderShapeList();
}

function renderShapeList() {
  shapeList.innerHTML = '';
  state.shapes.forEach((shape, index) => {
    const clone = templateRow.content.firstElementChild.cloneNode(true);
    clone.dataset.index = index.toString();
    const summary = clone.querySelector('.shape-summary');
    const def = SHAPE_DEFS[shape.type];
    if (def && def.summary) {
      summary.textContent = def.summary(shape);
    } else {
      summary.textContent = `${shape.type} shape`;
    }
    shapeList.appendChild(clone);
  });

  if (state.shapes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'shape-empty';
    empty.textContent = 'No shapes yet. Use the form above to add one.';
    shapeList.appendChild(empty);
  }
}

function addShape(type, values) {
  const sanitized = sanitizeShape(type, values);
  if (!sanitized) return;
  state.shapes.push(sanitized);
  render();
}

function updateShape(index, type, values) {
  const sanitized = sanitizeShape(type, values);
  if (!sanitized) return;
  state.shapes[index] = sanitized;
  render();
}

function deleteShape(index) {
  state.shapes.splice(index, 1);
  render();
}

function openEditDialog(index) {
  const shape = state.shapes[index];
  if (!shape) return;
  renderShapeFields(editFieldsContainer, shape.type, shape);
  editDialog.returnValue = 'cancel';
  editDialog.showModal();
  editDialog.addEventListener(
    'close',
    () => {
      if (editDialog.returnValue === 'confirm') {
        const values = formValues(editFieldsContainer);
        updateShape(index, shape.type, values);
        toastMessage('Shape updated');
      }
      editFieldsContainer.innerHTML = '';
    },
    { once: true }
  );
}

function toastMessage(message) {
  toast.textContent = message;
  toast.classList.add('active');
  setTimeout(() => toast.classList.remove('active'), 2200);
}

function downloadSvg() {
  const blob = new Blob([codeOutput.value], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'artwork.svg';
  document.body.appendChild(a);
  a.click();
  requestAnimationFrame(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  toastMessage('SVG downloaded');
}

function copyCode() {
  navigator.clipboard
    .writeText(codeOutput.value)
    .then(() => toastMessage('Code copied to clipboard'))
    .catch(() => toastMessage('Copy failed: clipboard not available'));
}

canvasWidthInput.addEventListener('input', () => {
  state.width = Number(canvasWidthInput.value) || state.width;
  render();
});

canvasHeightInput.addEventListener('input', () => {
  state.height = Number(canvasHeightInput.value) || state.height;
  render();
});

canvasBackgroundInput.addEventListener('input', () => {
  state.background = canvasBackgroundInput.value || state.background;
  render();
});

canvasGridSelect.addEventListener('change', () => {
  state.grid = canvasGridSelect.value;
  render();
});

shapeTypeSelect.addEventListener('change', () => {
  renderShapeFields(shapeFieldsContainer, shapeTypeSelect.value);
});

shapeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = formValues(shapeFieldsContainer);
  addShape(shapeTypeSelect.value, values);
  toastMessage(`${SHAPE_DEFS[shapeTypeSelect.value].label} added`);
});

shapeList.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest('.shape-row');
  if (!row) return;
  const index = Number(row.dataset.index);
  const action = target.dataset.action;
  if (action === 'delete') {
    deleteShape(index);
    toastMessage('Shape removed');
  }
  if (action === 'edit') {
    openEditDialog(index);
  }
});

clearShapesBtn.addEventListener('click', () => {
  state.shapes = [];
  render();
  toastMessage('Canvas cleared');
});

copyCodeBtn.addEventListener('click', copyCode);
downloadBtn.addEventListener('click', downloadSvg);

renderShapeFields(shapeFieldsContainer, shapeTypeSelect.value);
// Seed with a pleasant composition so the preview is never empty.
[
  {
    type: 'rectangle',
    data: {
      x: 64,
      y: 48,
      width: 240,
      height: 220,
      rx: 24,
      ry: 24,
      fill: '#1f2937',
      stroke: '#6366f1',
      strokeWidth: 6,
    },
  },
  {
    type: 'circle',
    data: {
      cx: 340,
      cy: 150,
      r: 88,
      fill: '#6366f1',
      stroke: '#312e81',
      strokeWidth: 12,
      opacity: 0.92,
    },
  },
  {
    type: 'text',
    data: {
      content: 'Vector vibes',
      x: 80,
      y: 320,
      fontSize: 48,
      fontFamily: '"Inter", sans-serif',
      fill: '#e0f2fe',
      fontWeight: '600',
      letterSpacing: '4px',
    },
  },
].forEach(({ type, data }) => {
  const shape = sanitizeShape(type, data);
  if (shape) {
    state.shapes.push(shape);
  }
});

render();
