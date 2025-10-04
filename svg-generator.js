const dimensionContainer = document.getElementById('dimension-controls');
const shapeSelect = document.getElementById('shape-select');
const fillInput = document.getElementById('fill-color');
const strokeInput = document.getElementById('stroke-color');
const strokeWidthInput = document.getElementById('stroke-width');
const strokeWidthOutput = document.getElementById('stroke-width-output');
const svg = document.getElementById('preview-svg');
const svgCode = document.getElementById('svg-code');
const downloadBtn = document.getElementById('download-btn');

const shapeConfigs = {
  rect: [
    { id: 'width', label: 'Width', min: 10, max: 300, value: 200 },
    { id: 'height', label: 'Height', min: 10, max: 300, value: 150 },
    { id: 'x', label: 'X Position', min: 0, max: 300, value: 50 },
    { id: 'y', label: 'Y Position', min: 0, max: 300, value: 75 },
    { id: 'rx', label: 'Corner Radius', min: 0, max: 80, value: 12 }
  ],
  circle: [
    { id: 'r', label: 'Radius', min: 10, max: 150, value: 80 },
    { id: 'cx', label: 'Center X', min: 0, max: 300, value: 150 },
    { id: 'cy', label: 'Center Y', min: 0, max: 300, value: 150 }
  ],
  ellipse: [
    { id: 'rx', label: 'Radius X', min: 10, max: 150, value: 110 },
    { id: 'ry', label: 'Radius Y', min: 10, max: 150, value: 70 },
    { id: 'cx', label: 'Center X', min: 0, max: 300, value: 150 },
    { id: 'cy', label: 'Center Y', min: 0, max: 300, value: 150 }
  ],
  polygon: [
    { id: 'sides', label: 'Sides', min: 3, max: 10, value: 6, step: 1 },
    { id: 'radius', label: 'Radius', min: 20, max: 150, value: 110 },
    { id: 'rotation', label: 'Rotation', min: 0, max: 360, value: 0 }
  ]
};

const formState = new Map();

function createControl({ id, label, min, max, value, step = 1 }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'control';
  wrapper.dataset.id = id;

  const controlLabel = document.createElement('label');
  controlLabel.setAttribute('for', `control-${id}`);
  controlLabel.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.id = `control-${id}`;
  input.name = id;
  input.min = min;
  input.max = max;
  input.value = value;
  input.step = step;

  const output = document.createElement('output');
  output.htmlFor = input.id;
  output.textContent = value;

  input.addEventListener('input', () => {
    output.textContent = input.value;
    formState.set(id, Number(input.value));
    renderSvg();
  });

  wrapper.append(controlLabel, input, output);
  return wrapper;
}

function buildDimensionControls(shape) {
  dimensionContainer.innerHTML = '';
  formState.clear();
  const config = shapeConfigs[shape];
  config.forEach((cfg) => {
    const control = createControl(cfg);
    dimensionContainer.appendChild(control);
    formState.set(cfg.id, Number(cfg.value));
  });
}

function polygonPoints(cx, cy, radius, sides, rotation = 0) {
  const angle = (Math.PI * 2) / sides;
  const rotationRad = (rotation * Math.PI) / 180;
  const points = [];
  for (let i = 0; i < sides; i++) {
    const currentAngle = i * angle + rotationRad - Math.PI / 2;
    const x = cx + radius * Math.cos(currentAngle);
    const y = cy + radius * Math.sin(currentAngle);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return points.join(' ');
}

function renderSvg() {
  const shape = shapeSelect.value;
  const fill = fillInput.value;
  const stroke = strokeInput.value;
  const strokeWidth = Number(strokeWidthInput.value);

  let shapeElement = '';
  const values = Object.fromEntries(formState);

  if (shape === 'rect') {
    const { width, height, x, y, rx } = values;
    shapeElement = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" />`;
  } else if (shape === 'circle') {
    const { r, cx, cy } = values;
    shapeElement = `<circle cx="${cx}" cy="${cy}" r="${r}" />`;
  } else if (shape === 'ellipse') {
    const { rx, ry, cx, cy } = values;
    shapeElement = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" />`;
  } else if (shape === 'polygon') {
    const { sides, radius, rotation } = values;
    const cx = 150;
    const cy = 150;
    const points = polygonPoints(cx, cy, radius, sides, rotation);
    shapeElement = `<polygon points="${points}" />`;
  }

  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
  <g fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round">
    ${shapeElement}
  </g>
</svg>`;

  svg.innerHTML = `
    <g fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round">
      ${shapeElement}
    </g>`;

  svgCode.value = svgMarkup;
}

function handleStrokeWidthChange() {
  strokeWidthOutput.textContent = strokeWidthInput.value;
  renderSvg();
}

function init() {
  buildDimensionControls(shapeSelect.value);
  strokeWidthOutput.textContent = strokeWidthInput.value;
  renderSvg();
}

shapeSelect.addEventListener('change', () => {
  buildDimensionControls(shapeSelect.value);
  renderSvg();
});

fillInput.addEventListener('input', renderSvg);
strokeInput.addEventListener('input', renderSvg);
strokeWidthInput.addEventListener('input', handleStrokeWidthChange);

downloadBtn.addEventListener('click', () => {
  const blob = new Blob([svgCode.value], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'generated-shape.svg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

init();
