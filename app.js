
import * as THREE from "three";
import { XRButton } from "three/addons/webxr/XRButton.js";

// ------------------------------------------------------------
// Beat Saber VR Map Editor
// v3 note-only output. Audio stays local in the browser.
// ------------------------------------------------------------

const $ = id => document.getElementById(id);
const DIFFICULTIES = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"];
const RANKS = { Easy: 1, Normal: 3, Hard: 5, Expert: 7, ExpertPlus: 9 };
const DIRECTIONS = ["↓", "↑", "←", "→", "↖", "↗", "↙", "↘", "•"];
const DIR_ANGLES = { 0: Math.PI, 1: 0, 2: Math.PI / 2, 3: -Math.PI / 2, 4: Math.PI / 4, 5: -Math.PI / 4, 6: 3 * Math.PI / 4, 7: -3 * Math.PI / 4, 8: 0 };
const GRID_SPACING = 0.46;
const EDITOR_Z = -3.05;
const PREVIEW_SECONDS = 2.15;

let levels = Object.fromEntries(DIFFICULTIES.map(name => [name, []]));
let activeDifficulty = "Expert";
let selectedId = null;
let nextNoteId = 1;
let undoStack = [];
let redoStack = [];
let audioFile = null;
let audioURL = null;
let audioElement = null;
let audioDuration = 0;
let manualBeat = 0;
let metronomeEnabled = false;
let metronomeContext = null;
let lastMetronomeBeat = -1;
let ffmpegInstance = null;
let ffmpegLoadPromise = null;
let timelineScale = 24;
let lastTimelineDraw = -1000;
let isTimelineDragging = false;
let timelineDragId = null;
let timelinePointerMoved = false;
let vrDrag = null;
let controllerObjects = [];
let controllerButtonStates = new WeakMap();
let statusTimer = null;

const viewport = $("viewport");
const timelineCanvas = $("timelineCanvas");
const timelineCtx = timelineCanvas.getContext("2d");
const timelineScroll = $("timelineScroll");

// Three.js scene. Scene lighting is only for the editor preview and is not exported.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1119);
const camera = new THREE.PerspectiveCamera(66, 1, 0.05, 100);
camera.position.set(0, 1.58, 5.8);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: "high-performance"
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
viewport.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xe3eaff, 0x323c52, 1.9));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
keyLight.position.set(2.5, 4, 4);
scene.add(keyLight);

const editorRoot = new THREE.Group();
editorRoot.position.set(0, 1.57, EDITOR_Z);
scene.add(editorRoot);
const editNoteMeshes = new Map();
const previewNoteMeshes = new Map();
const cellMeshes = [];
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tempMatrix = new THREE.Matrix4();
const editPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -EDITOR_Z);

const panelBack = new THREE.Mesh(
  new THREE.PlaneGeometry(2.72, 2.48),
  new THREE.MeshBasicMaterial({
    color: 0x121a28,
    transparent: true,
    opacity: 0.97,
    side: THREE.DoubleSide
  })
);
panelBack.position.z = -0.065;
editorRoot.add(panelBack);

const cellMaterial = new THREE.MeshBasicMaterial({
  color: 0x3f526d,
  transparent: true,
  opacity: 0.23,
  side: THREE.DoubleSide
});
const cellGeometry = new THREE.PlaneGeometry(0.43, 0.43);

for (let y = 0; y < 3; y++) {
  for (let x = 0; x < 4; x++) {
    const cell = new THREE.Mesh(cellGeometry, cellMaterial.clone());
    cell.position.set(
      (x - 1.5) * GRID_SPACING,
      (y - 1) * GRID_SPACING,
      0
    );
    cell.userData = { kind: "cell", x, y };
    editorRoot.add(cell);
    cellMeshes.push(cell);
  }
}

const lineMaterial = new THREE.LineBasicMaterial({
  color: 0x52617a,
  transparent: true,
  opacity: 0.82
});

function addLine(a, b) {
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  editorRoot.add(new THREE.Line(geometry, lineMaterial));
}

for (let x = 0; x <= 4; x++) {
  const xx = (x - 2) * GRID_SPACING;
  addLine(
    new THREE.Vector3(xx, -1.5 * GRID_SPACING, 0.018),
    new THREE.Vector3(xx, 1.5 * GRID_SPACING, 0.018)
  );
}

for (let y = 0; y <= 3; y++) {
  const yy = (y - 1.5) * GRID_SPACING;
  addLine(
    new THREE.Vector3(-2 * GRID_SPACING, yy, 0.018),
    new THREE.Vector3(2 * GRID_SPACING, yy, 0.018)
  );
}

// Small labels on the board make the 0..3 columns and 0..2 rows legible in VR.
function addBoardLabel(text, x, y) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#a6b4d1";
  ctx.font = "28px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false
  });

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.14, 0.08),
    material
  );

  mesh.position.set(x, y, 0.03);
  editorRoot.add(mesh);
}

for (let x = 0; x < 4; x++) {
  addBoardLabel(
    String(x),
    (x - 1.5) * GRID_SPACING,
    -0.88
  );
}

for (let y = 0; y < 3; y++) {
  addBoardLabel(
    String(y),
    -1.24,
    (y - 1) * GRID_SPACING
  );
}

// VR-accessible difficulty and transport controls are part of the 3D board.
const vrDifficultyTiles = new Map();
let vrBeatTile = null;
let vrPlayTile = null;
let vrStopTile = null;

function makeVrTile(text, width, height, x, y, kind, value = null) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;

  const context = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    material
  );

  mesh.position.set(x, y, 0.045);
  mesh.userData = { kind, value, canvas, context, texture };

  paintVrTile(mesh, text, false);
  editorRoot.add(mesh);

  return mesh;
}

function paintVrTile(mesh, text, active = false, subdued = false) {
  const ctx = mesh.userData.context;
  const canvas = mesh.userData.canvas;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = active
    ? "#354576"
    : subdued
      ? "#182131"
      : "#202b3e";

  ctx.strokeStyle = active ? "#aabaff" : "#586985";
  ctx.lineWidth = 5;

  ctx.beginPath();

  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, 22);
  } else {
    ctx.rect(8, 8, canvas.width - 16, canvas.height - 16);
  }

  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = active
    ? "#ffffff"
    : subdued
      ? "#8794ad"
      : "#d5ddec";

  ctx.font = "bold 39px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  mesh.userData.texture.needsUpdate = true;
}

DIFFICULTIES.forEach((name, index) => {
  const x = (index - 2) * 0.5;

  const tile = makeVrTile(
    name === "ExpertPlus" ? "EXPERT+" : name.toUpperCase(),
    0.46,
    0.18,
    x,
    0.98,
    "difficulty",
    name
  );

  vrDifficultyTiles.set(name, tile);
});

vrPlayTile = makeVrTile(
  "PLAY / PAUSE", 0.65, 0.17, -0.77, -1.09, "action", "playpause"
);

vrStopTile = makeVrTile(
  "STOP", 0.42, 0.17, -0.13, -1.09, "action", "stop"
);

vrBeatTile = makeVrTile(
  "BEAT 0.00", 0.80, 0.17, 0.74, -1.09, "readout", "beat"
);

function refreshVrControls() {
  for (const [name, tile] of vrDifficultyTiles) {
    const label = name === "ExpertPlus" ? "EXPERT+" : name.toUpperCase();
    paintVrTile(tile, label, name === activeDifficulty);
  }

  if (vrPlayTile) {
    paintVrTile(
      vrPlayTile,
      audioElement && !audioElement.paused ? "PAUSE" : "PLAY",
      false
    );
  }

  if (vrStopTile) paintVrTile(vrStopTile, "STOP", false);
}

function updateVrBeatReadout() {
  if (!vrBeatTile) return;

  const value = `BEAT ${currentBeat().toFixed(2)}`;

  if (vrBeatTile.userData.lastText !== value) {
    vrBeatTile.userData.lastText = value;
    paintVrTile(vrBeatTile, value, false, true);
  }
}

refreshVrControls();

const floor = new THREE.GridHelper(30, 60, 0x303b50, 0x1b2433);
floor.position.y = 0;
scene.add(floor);

// ------------------------------------------------------------
// Project and history
// ------------------------------------------------------------

function cloneLevels(source = levels) {
  return JSON.parse(JSON.stringify(source));
}

function pushUndo() {
  undoStack.push(cloneLevels());

  if (undoStack.length > 80) undoStack.shift();

  redoStack.length = 0;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $("undoBtn").disabled = undoStack.length === 0;
  $("redoBtn").disabled = redoStack.length === 0;
}

function undo() {
  if (!undoStack.length) return;

  redoStack.push(cloneLevels());
  levels = undoStack.pop();
  selectedId = null;

  rebuildAllViews();
  updateHistoryButtons();
  setStatus("Undo complete.");
}

function redo() {
  if (!redoStack.length) return;

  undoStack.push(cloneLevels());
  levels = redoStack.pop();
  selectedId = null;

  rebuildAllViews();
  updateHistoryButtons();
  setStatus("Redo complete.");
}

function currentNotes() {
  return levels[activeDifficulty];
}

function selectedNote() {
  return currentNotes().find(note => note.id === selectedId) || null;
}

function bpm() {
  return Math.max(1, Number($("bpm").value) || 120);
}

function offsetSeconds() {
  return Number($("songOffset").value) || 0;
}

function snapBeat(beat) {
  const step = Number($("snap").value);

  if (!step) return Math.max(0, beat);

  return Math.max(0, Math.round(beat / step) * step);
}

function currentTimeSeconds() {
  if (audioElement) return audioElement.currentTime || 0;

  return manualBeat * 60 / bpm() + offsetSeconds();
}

function currentBeat() {
  return Math.max(
    0,
    (currentTimeSeconds() - offsetSeconds()) * bpm() / 60
  );
}

function seekToBeat(beat, scrollIntoView = false) {
  const safeBeat = Math.max(0, Number(beat) || 0);
  manualBeat = safeBeat;

  if (audioElement) {
    const target = Math.max(
      0,
      safeBeat * 60 / bpm() + offsetSeconds()
    );

    audioElement.currentTime = Math.min(
      audioDuration || target,
      target
    );
  }

  updateTransportReadout();
  drawTimeline(true);

  if (scrollIntoView) {
    const x = safeBeat * timelineScale;
    const pad = timelineScroll.clientWidth * 0.35;

    timelineScroll.scrollLeft = Math.max(0, x - pad);
  }
}

function setStatus(message, kind = "normal", timeout = 4800) {
  const line = $("statusLine");

  line.textContent = message;
  line.className = "status-line" +
    (kind === "error" ? " error" : kind === "success" ? " success" : "");

  clearTimeout(statusTimer);

  if (timeout > 0) {
    statusTimer = setTimeout(() => {
      line.className = "status-line";
    }, timeout);
  }
}

// ------------------------------------------------------------
// Difficulty switching
// ------------------------------------------------------------

function switchDifficulty(name) {
  if (!levels[name]) return;

  activeDifficulty = name;
  selectedId = null;

  document.querySelectorAll("#difficultyGrid button").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.difficulty === name
    );
  });

  $("selectedDifficultyLabel").textContent =
    name === "ExpertPlus" ? "Expert+" : name;

  rebuildAllViews();
  refreshVrControls();

  setStatus(
    `Editing ${name === "ExpertPlus" ? "Expert+" : name}.`
  );
}

// ------------------------------------------------------------
// Note meshes and editor view
// ------------------------------------------------------------

function directionRotation(direction, angle = 0) {
  return (DIR_ANGLES[direction] ?? 0) +
    (Number(angle) || 0) * Math.PI / 180;
}

function createNoteMesh(note, preview = false) {
  const group = new THREE.Group();

  const color = note.c === 0 ? 0xff465f : 0x469cff;

  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: preview ? 0.12 : 0.2,
    roughness: 0.35,
    metalness: 0.08
  });

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.30, 0.30, 0.09),
    bodyMat
  );

  group.add(body);

  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.075, 0.15, 3),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );

  arrow.rotation.z = directionRotation(note.d, note.a);
  arrow.position.z = 0.065;

  group.add(arrow);

  group.position.set(
    (note.x - 1.5) * GRID_SPACING,
    (note.y - 1) * GRID_SPACING,
    preview ? -1 : 0.09
  );

  group.userData = {
    kind: preview ? "preview" : "note",
    id: note.id
  };

  editorRoot.add(group);

  return group;
}

function disposeObject(object) {
  object.traverse(child => {
    if (child.geometry) child.geometry.dispose();

    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(material => material.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
}

function clearMeshMap(map) {
  for (const object of map.values()) {
    editorRoot.remove(object);
    disposeObject(object);
  }

  map.clear();
}

function rebuildNoteMeshes() {
  clearMeshMap(editNoteMeshes);
  clearMeshMap(previewNoteMeshes);

  for (const note of currentNotes()) {
    editNoteMeshes.set(
      note.id,
      createNoteMesh(note, false)
    );
  }

  updateSelectionVisuals();
}

function updateSelectionVisuals() {
  for (const [id, object] of editNoteMeshes) {
    const selected = id === selectedId;
    const material = object.children[0].material;

    material.emissiveIntensity = selected ? 0.85 : 0.2;
    object.scale.setScalar(selected ? 1.12 : 1);
  }
}

function selectNote(id) {
  if (
    id != null &&
    !currentNotes().some(note => note.id === id)
  ) return;

  selectedId = id;

  updateSelectionVisuals();
  updateInspector();
  renderNoteList();
  drawTimeline(true);
}

function addNoteAt(x, y, beat = currentBeat()) {
  const targetBeat = snapBeat(beat);

  const collision = currentNotes().find(note =>
    note.b === targetBeat &&
    note.x === x &&
    note.y === y
  );

  if (collision) {
    selectNote(collision.id);
    setStatus("There is already a note in that cell at that beat.");
    return collision;
  }

  pushUndo();

  const note = {
    id: nextNoteId++,
    b: Number(targetBeat.toFixed(4)),
    x,
    y,
    c: Number($("noteColor").value),
    d: Number($("noteDirection").value),
    a: 0
  };

  currentNotes().push(note);

  editNoteMeshes.set(
    note.id,
    createNoteMesh(note, false)
  );

  selectNote(note.id);
  refreshCounts();
  drawTimeline(true);

  setStatus(
    `Added ${note.c === 0 ? "red" : "blue"} note at beat ${note.b.toFixed(3)}.`,
    "success"
  );

  return note;
}

function updateNote(id, patch, history = true) {
  const note = currentNotes().find(item => item.id === id);

  if (!note) return;

  if (history) pushUndo();

  Object.assign(note, patch);

  const object = editNoteMeshes.get(id);

  if (object) {
    object.position.set(
      (note.x - 1.5) * GRID_SPACING,
      (note.y - 1) * GRID_SPACING,
      0.09
    );

    object.children[0].material.color.set(
      note.c === 0 ? 0xff465f : 0x469cff
    );

    object.children[0].material.emissive.set(
      note.c === 0 ? 0xff465f : 0x469cff
    );

    object.children[1].rotation.z =
      directionRotation(note.d, note.a);
  }

  updateSelectionVisuals();
  updateInspector();
  renderNoteList();
  refreshCounts();
  drawTimeline(true);
}

function deleteSelected() {
  const note = selectedNote();

  if (!note) return;

  pushUndo();

  const object = editNoteMeshes.get(note.id);

  if (object) {
    editorRoot.remove(object);
    disposeObject(object);
    editNoteMeshes.delete(note.id);
  }

  const previewObject = previewNoteMeshes.get(note.id);

  if (previewObject) {
    editorRoot.remove(previewObject);
    disposeObject(previewObject);
    previewNoteMeshes.delete(note.id);
  }

  levels[activeDifficulty] = currentNotes().filter(
    item => item.id !== note.id
  );

  selectedId = null;

  updateInspector();
  renderNoteList();
  refreshCounts();
  drawTimeline(true);

  setStatus("Selected note deleted.");
}

function rotateSelected() {
  const note = selectedNote();

  if (!note) return;

  updateNote(note.id, {
    d: (note.d + 1) % 9
  });
}

function duplicateSelected() {
  const note = selectedNote();

  if (!note) return;

  const step = Number($("snap").value) || 0.25;
  const beat = Number((note.b + step).toFixed(4));

  if (currentNotes().some(other =>
    other.b === beat &&
    other.x === note.x &&
    other.y === note.y
  )) {
    setStatus(
      "Cannot duplicate there. That grid cell already contains a note at that beat."
    );
    return;
  }

  pushUndo();

  const copy = {
    ...note,
    id: nextNoteId++,
    b: beat
  };

  currentNotes().push(copy);

  editNoteMeshes.set(
    copy.id,
    createNoteMesh(copy, false)
  );

  selectNote(copy.id);
  refreshCounts();
  drawTimeline(true);
}

function clearCurrentDifficulty() {
  if (!currentNotes().length) return;

  pushUndo();

  levels[activeDifficulty] = [];
  selectedId = null;

  rebuildAllViews();

  setStatus(`${activeDifficulty} difficulty cleared.`);
}

function copyFromLowerDifficulty() {
  const index = DIFFICULTIES.indexOf(activeDifficulty);

  if (index <= 0) {
    setStatus("Easy is the lowest difficulty.");
    return;
  }

  const sourceName = DIFFICULTIES[index - 1];

  pushUndo();

  levels[activeDifficulty] = levels[sourceName].map(note => ({
    ...note,
    id: nextNoteId++
  }));

  selectedId = null;

  rebuildAllViews();

  setStatus(
    `Copied ${sourceName} notes into ${activeDifficulty}.`,
    "success"
  );
}

function rebuildAllViews() {
  rebuildNoteMeshes();
  updateInspector();
  renderNoteList();
  refreshCounts();
  refreshDifficultyCount();
  refreshVrControls();
  drawTimeline(true);
  updateHistoryButtons();
}

// ------------------------------------------------------------
// Timeline renderer and editor interactions
// ------------------------------------------------------------

function timelineEndBeat() {
  const noteEnd = currentNotes().reduce(
    (max, note) => Math.max(max, note.b),
    0
  );

  const audioEnd = audioDuration > 0
    ? Math.max(0, (audioDuration - offsetSeconds()) * bpm() / 60)
    : 0;

  return Math.max(
    64,
    Math.ceil(Math.max(noteEnd, audioEnd) / 16) * 16 + 16
  );
}

function timelineNoteRow(note) {
  return (2 - note.y) * 4 + note.x;
}

function timelineBeatFromEvent(event) {
  const rect = timelineCanvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;

  return Math.max(0, localX / timelineScale);
}

function timelineRowFromEvent(event) {
  const rect = timelineCanvas.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const row = Math.floor((y - 36) / 14);

  return row >= 0 && row < 12 ? row : null;
}

function drawTimeline(force = false) {
  if (!timelineCanvas || !timelineCtx) return;

  const beat = currentBeat();

  if (!force && Math.abs(beat - lastTimelineDraw) < 0.045) {
    return;
  }

  lastTimelineDraw = beat;

  const endBeat = timelineEndBeat();
  const cssWidth = Math.max(
    1200,
    Math.ceil(endBeat * timelineScale + 40)
  );

  const cssHeight = 220;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

  if (
    timelineCanvas.width !== Math.round(cssWidth * dpr) ||
    timelineCanvas.height !== Math.round(cssHeight * dpr)
  ) {
    timelineCanvas.width = Math.round(cssWidth * dpr);
    timelineCanvas.height = Math.round(cssHeight * dpr);

    timelineCanvas.style.width = `${cssWidth}px`;
    timelineCanvas.style.height = `${cssHeight}px`;
  }

  const ctx = timelineCtx;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  ctx.fillStyle = "#0d121c";
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const top = 36;
  const rowH = 14;

  ctx.font = "9px Inter, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#95a2ba";

  for (let row = 0; row < 12; row++) {
    const y = top + row * rowH;

    ctx.fillStyle = row % 4 < 2 ? "#121a27" : "#101723";
    ctx.fillRect(0, y, cssWidth, rowH);

    ctx.strokeStyle = "#273247";
    ctx.lineWidth = 0.6;

    ctx.beginPath();
    ctx.moveTo(0, y + rowH);
    ctx.lineTo(cssWidth, y + rowH);
    ctx.stroke();

    ctx.fillStyle = "#66748d";
    ctx.fillText(`${2 - Math.floor(row / 4)}:${row % 4}`, 5, y + rowH / 2);
  }

  ctx.fillStyle = "#9aa8c3";
  ctx.fillRect(0, 0, cssWidth, 35);

  const totalBeats = Math.floor(cssWidth / timelineScale);

  for (let b = 0; b <= totalBeats; b++) {
    const x = b * timelineScale;
    const major = b % 4 === 0;

    ctx.strokeStyle = major
      ? "#52617b"
      : (b % 2 === 0 ? "#303c53" : "#202a3b");

    ctx.lineWidth = major ? 1 : 0.55;

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();

    if (major) {
      ctx.fillStyle = "#d0d8e8";
      ctx.fillText(String(b), x + 3, 17);

      ctx.fillStyle = "#6d7b95";
      ctx.fillText(`bar ${b / 4 + 1}`, x + 3, 29);
    }
  }

  for (const note of currentNotes()) {
    const x = note.b * timelineScale;
    const y = top + timelineNoteRow(note) * rowH + rowH / 2;
    const isSelected = note.id === selectedId;

    ctx.beginPath();
    ctx.fillStyle = note.c === 0 ? "#ff526d" : "#4d9fff";

    ctx.arc(
      x,
      y,
      isSelected ? 5.1 : 4.1,
      0,
      Math.PI * 2
    );

    ctx.fill();

    if (isSelected) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.arc(x, y, 7.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  const px = beat * timelineScale;

  ctx.strokeStyle = "#f3f5ff";
  ctx.lineWidth = 1.6;

  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, cssHeight);
  ctx.stroke();

  ctx.fillStyle = "#f3f5ff";

  ctx.beginPath();
  ctx.moveTo(px - 5, 0);
  ctx.lineTo(px + 5, 0);
  ctx.lineTo(px, 7);
  ctx.closePath();
  ctx.fill();

  $("timelinePosition").textContent = `Beat ${beat.toFixed(3)}`;
}

timelineCanvas.addEventListener("pointerdown", event => {
  const beat = timelineBeatFromEvent(event);
  const row = timelineRowFromEvent(event);

  let nearest = null;
  let nearestDistance = Infinity;

  if (row !== null) {
    for (const note of currentNotes()) {
      if (timelineNoteRow(note) !== row) continue;

      const distance = Math.abs(
        note.b * timelineScale - beat * timelineScale
      );

      if (distance < nearestDistance && distance < 11) {
        nearest = note;
        nearestDistance = distance;
      }
    }
  }

  if (nearest) {
    selectNote(nearest.id);
    pushUndo();

    isTimelineDragging = true;
    timelineDragId = nearest.id;
    timelinePointerMoved = false;

    timelineCanvas.setPointerCapture(event.pointerId);
  } else {
    seekToBeat(snapBeat(beat));
  }
});

timelineCanvas.addEventListener("pointermove", event => {
  if (!isTimelineDragging || timelineDragId == null) return;

  timelinePointerMoved = true;

  const note = currentNotes().find(
    item => item.id === timelineDragId
  );

  if (!note) return;

  const beat = Math.max(
    0,
    snapBeat(timelineBeatFromEvent(event))
  );

  const row = timelineRowFromEvent(event);

  const patch = {
    b: Number(beat.toFixed(4))
  };

  if (row !== null) {
    patch.x = row % 4;
    patch.y = 2 - Math.floor(row / 4);
  }

  Object.assign(note, patch);

  const object = editNoteMeshes.get(note.id);

  if (object) {
    object.position.set(
      (note.x - 1.5) * GRID_SPACING,
      (note.y - 1) * GRID_SPACING,
      0.09
    );
  }

  updateInspector();
  renderNoteList();
  refreshCounts();
  drawTimeline(true);
});

function endTimelineDrag() {
  if (isTimelineDragging) {
    isTimelineDragging = false;
    timelineDragId = null;

    drawTimeline(true);
    setStatus("Note moved on the timeline.", "success");
  }
}

timelineCanvas.addEventListener("pointerup", endTimelineDrag);
timelineCanvas.addEventListener("pointercancel", endTimelineDrag);

// ------------------------------------------------------------
// UI refresh and inspector
// ------------------------------------------------------------

function refreshCounts() {
  $("noteCount").textContent = `${currentNotes().length} notes`;

  $("selectedDifficultyLabel").textContent =
    activeDifficulty === "ExpertPlus" ? "Expert+" : activeDifficulty;
}

function refreshDifficultyCount() {
  const count = DIFFICULTIES.filter(name => levels[name]).length;
  $("difficultyCount").textContent = String(count);
}

function updateInspector() {
  const note = selectedNote();

  if (!note) {
    $("selectedInfo").textContent = "No note selected";
    $("selectedBeatInput").value = "";
    $("selectedAngleInput").value = "0";
    $("selectedBeatInput").disabled = true;
    $("selectedAngleInput").disabled = true;
    return;
  }

  $("selectedInfo").textContent =
    `${note.c === 0 ? "Red" : "Blue"} note · column ${note.x} · row ${note.y} · ${DIRECTIONS[note.d]}`;

  $("selectedBeatInput").disabled = false;
  $("selectedAngleInput").disabled = false;

  $("selectedBeatInput").value = note.b.toFixed(4);
  $("selectedAngleInput").value = note.a || 0;

  $("noteColor").value = String(note.c);
  $("noteDirection").value = String(note.d);
  $("gridX").value = String(note.x);
  $("gridY").value = String(note.y);
}

function renderNoteList() {
  const list = $("noteList");
  list.replaceChildren();

  if (!currentNotes().length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No notes in this difficulty";
    list.appendChild(empty);
    return;
  }

  const sorted = [...currentNotes()]
    .sort((a, b) => a.b - b.b)
    .slice(0, 50);

  for (const note of sorted) {
    const item = document.createElement("div");

    item.className =
      "note-item" + (note.id === selectedId ? " active" : "");

    const main = document.createElement("div");
    main.className = "note-main";

    const dot = document.createElement("i");
    dot.className =
      `note-dot ${note.c === 0 ? "red" : "blue"}`;

    const text = document.createElement("span");

    text.textContent =
      `Beat ${note.b.toFixed(3)} · ${note.x},${note.y}`;

    main.append(dot, text);

    const direction = document.createElement("small");
    direction.textContent = DIRECTIONS[note.d];

    item.append(main, direction);

    item.onclick = () => {
      selectNote(note.id);
      seekToBeat(note.b, true);
    };

    list.appendChild(item);
  }
}

function updateTransportReadout() {
  const time = audioElement
    ? audioElement.currentTime
    : manualBeat * 60 / bpm() + offsetSeconds();

  const total = audioDuration;

  $("currentTime").textContent = formatTime(time);

  $("totalTime").textContent =
    total > 0 ? formatTime(total).split(".")[0] : "0:00";

  $("audioSeek").value =
    total > 0
      ? String(Math.min(1000, Math.max(0, time / total * 1000)))
      : "0";
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remain = (safe % 60).toFixed(3).padStart(6, "0");

  return `${minutes}:${remain}`;
}

// ------------------------------------------------------------
// Audio import, playback and metronome
// ------------------------------------------------------------

async function importAudio(file) {
  if (!file) return;

  if (audioElement) {
    audioElement.pause();
    audioElement.src = "";
  }

  if (audioURL) URL.revokeObjectURL(audioURL);

  audioFile = file;
  audioURL = URL.createObjectURL(file);

  audioElement = new Audio();
  audioElement.preload = "metadata";
  audioElement.src = audioURL;

  await new Promise((resolve, reject) => {
    audioElement.addEventListener(
      "loadedmetadata",
      resolve,
      { once: true }
    );

    audioElement.addEventListener(
      "error",
      () => reject(new Error("The browser could not read this audio file.")),
      { once: true }
    );

    audioElement.load();
  });

  audioDuration = Number.isFinite(audioElement.duration)
    ? audioElement.duration
    : 0;

  manualBeat = 0;

  $("audioName").textContent = file.name;
  $("audioStatus").textContent = "AUDIO LOADED";
  $("audioStatus").classList.add("loaded");
  $("playBtn").textContent = "▶ Play";

  refreshVrControls();
  updateTransportReadout();
  drawTimeline(true);

  setStatus(
    `Loaded ${file.name}. Audio is kept in this browser until you export.`,
    "success"
  );
}

async function togglePlayback() {
  if (!audioElement) {
    setStatus("Import an audio file before playing.");
    return;
  }

  try {
    if (audioElement.paused) {
      await audioElement.play();

      $("playBtn").textContent = "Ⅱ Pause";

      if (metronomeEnabled) {
        await ensureMetronomeContext();
      }
    } else {
      audioElement.pause();
      $("playBtn").textContent = "▶ Play";
    }

    refreshVrControls();
  } catch (error) {
    setStatus(`Playback error: ${error.message}`, "error");
  }
}

function stopPlayback() {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
  }

  manualBeat = 0;

  $("playBtn").textContent = "▶ Play";

  refreshVrControls();

  lastMetronomeBeat = -1;

  updateTransportReadout();
  drawTimeline(true);
}

function ensureMetronomeContext() {
  if (!metronomeContext) {
    const AudioCtx =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioCtx) {
      throw new Error("Web Audio is not supported in this browser.");
    }

    metronomeContext = new AudioCtx();
  }

  return metronomeContext.resume();
}

function metronomeClick(accent = false) {
  if (!metronomeContext) return;

  const osc = metronomeContext.createOscillator();
  const gain = metronomeContext.createGain();

  osc.type = "sine";
  osc.frequency.value = accent ? 1450 : 950;

  gain.gain.setValueAtTime(
    accent ? 0.09 : 0.055,
    metronomeContext.currentTime
  );

  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    metronomeContext.currentTime + 0.045
  );

  osc.connect(gain);
  gain.connect(metronomeContext.destination);

  osc.start();
  osc.stop(metronomeContext.currentTime + 0.05);
}

async function toggleMetronome() {
  metronomeEnabled = !metronomeEnabled;

  $("metronomeBtn").classList.toggle(
    "active",
    metronomeEnabled
  );

  $("metronomeBtn").textContent =
    metronomeEnabled ? "Metronome on" : "Metronome off";

  if (metronomeEnabled) {
    try {
      await ensureMetronomeContext();

      lastMetronomeBeat = Math.floor(currentBeat()) - 1;
    } catch (error) {
      metronomeEnabled = false;

      $("metronomeBtn").classList.remove("active");
      $("metronomeBtn").textContent = "Metronome off";

      setStatus(error.message, "error");
    }
  }
}

function updateMetronome() {
  if (
    !metronomeEnabled ||
    !audioElement ||
    audioElement.paused
  ) return;

  const beat = Math.floor(currentBeat() + 0.0001);

  if (beat > lastMetronomeBeat) {
    const count = Math.min(
      beat - lastMetronomeBeat,
      5
    );

    for (let i = 0; i < count; i++) {
      const tickBeat = lastMetronomeBeat + i + 1;

      metronomeClick(tickBeat % 4 === 0);
    }

    lastMetronomeBeat = beat;
  }
}

// ------------------------------------------------------------
// Focus the editing board on the current beat.
// The timeline still retains every note, but VR only shows
// notes at the playhead plus the selected note.
// ------------------------------------------------------------

function updateEditorNoteVisibility() {
  const beat = currentBeat();
  const snap = Number($("snap").value) || 0.125;
  const windowBeats = Math.max(0.06, snap * 0.55);

  for (const note of currentNotes()) {
    const object = editNoteMeshes.get(note.id);

    if (object) {
      object.visible =
        note.id === selectedId ||
        Math.abs(note.b - beat) <= windowBeats;
    }
  }
}

// ------------------------------------------------------------
// Incoming-note visual preview
// ------------------------------------------------------------

function updateIncomingPreview() {
  const beat = currentBeat();
  const notes = currentNotes();
  const needed = new Set();

  for (const note of notes) {
    const secondsUntil =
      (note.b - beat) * 60 / bpm();

    if (
      secondsUntil <= 0 ||
      secondsUntil > PREVIEW_SECONDS
    ) continue;

    needed.add(note.id);

    let object = previewNoteMeshes.get(note.id);

    if (!object) {
      object = createNoteMesh(note, true);
      previewNoteMeshes.set(note.id, object);
    }

    const progress =
      1 - secondsUntil / PREVIEW_SECONDS;

    object.position.z = -10.6 + progress * 7.48;

    object.position.x =
      (note.x - 1.5) * GRID_SPACING;

    object.position.y =
      (note.y - 1) * GRID_SPACING;

    object.children[1].rotation.z =
      directionRotation(note.d, note.a);

    object.visible = true;
  }

  for (const [id, object] of previewNoteMeshes) {
    if (!needed.has(id)) {
      editorRoot.remove(object);
      disposeObject(object);
      previewNoteMeshes.delete(id);
    }
  }
}

// ------------------------------------------------------------
// WebXR controls and desktop pointer controls
// ------------------------------------------------------------

function resolveHitObject(object) {
  let current = object;

  while (
    current &&
    current !== editorRoot &&
    !current.userData?.kind
  ) {
    current = current.parent;
  }

  return current && current !== editorRoot
    ? current
    : null;
}

function raycastEditor(rayOrigin, rayDirection) {
  raycaster.ray.origin.copy(rayOrigin);
  raycaster.ray.direction.copy(rayDirection).normalize();

  const hits = raycaster.intersectObjects(
    editorRoot.children,
    true
  );

  for (const hit of hits) {
    const target = resolveHitObject(hit.object);

    if (
      target &&
      target.userData.kind === "note" &&
      !target.visible
    ) continue;

    if (
      target &&
      ["note", "cell", "difficulty", "action"].includes(
        target.userData.kind
      )
    ) {
      return {
        target,
        point: hit.point
      };
    }
  }

  return null;
}

function handleControllerSelect(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);

  const origin = new THREE.Vector3().setFromMatrixPosition(
    controller.matrixWorld
  );

  const direction = new THREE.Vector3(0, 0, -1)
    .applyMatrix4(tempMatrix)
    .normalize();

  const hit = raycastEditor(origin, direction);

  if (!hit) return;

  if (hit.target.userData.kind === "note") {
    selectNote(hit.target.userData.id);
    return;
  }

  if (hit.target.userData.kind === "cell") {
    addNoteAt(
      hit.target.userData.x,
      hit.target.userData.y,
      currentBeat()
    );

    return;
  }

  if (hit.target.userData.kind === "difficulty") {
    switchDifficulty(hit.target.userData.value);
    return;
  }

  if (hit.target.userData.kind === "action") {
    if (hit.target.userData.value === "playpause") {
      togglePlayback();
    } else if (hit.target.userData.value === "stop") {
      stopPlayback();
    }
  }
}

function beginControllerDrag(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);

  const origin = new THREE.Vector3().setFromMatrixPosition(
    controller.matrixWorld
  );

  const direction = new THREE.Vector3(0, 0, -1)
    .applyMatrix4(tempMatrix)
    .normalize();

  const hit = raycastEditor(origin, direction);

  if (!hit || hit.target.userData.kind !== "note") return;

  const id = hit.target.userData.id;

  selectNote(id);
  pushUndo();

  vrDrag = { controller, id };
}

function updateControllerDrag() {
  if (!vrDrag) return;

  const { controller, id } = vrDrag;

  tempMatrix.identity().extractRotation(controller.matrixWorld);

  const origin = new THREE.Vector3().setFromMatrixPosition(
    controller.matrixWorld
  );

  const direction = new THREE.Vector3(0, 0, -1)
    .applyMatrix4(tempMatrix)
    .normalize();

  raycaster.ray.origin.copy(origin);
  raycaster.ray.direction.copy(direction);

  const worldPoint = new THREE.Vector3();

  if (!raycaster.ray.intersectPlane(editPlane, worldPoint)) {
    return;
  }

  const local = editorRoot.worldToLocal(worldPoint);

  const x = Math.min(
    3,
    Math.max(0, Math.round(local.x / GRID_SPACING + 1.5))
  );

  const y = Math.min(
    2,
    Math.max(0, Math.round(local.y / GRID_SPACING + 1))
  );

  const note = currentNotes().find(item => item.id === id);

  if (!note) return;

  note.x = x;
  note.y = y;

  const object = editNoteMeshes.get(id);

  if (object) {
    object.position.set(
      (x - 1.5) * GRID_SPACING,
      (y - 1) * GRID_SPACING,
      0.09
    );
  }

  updateInspector();
  renderNoteList();
  drawTimeline();
}

function endControllerDrag() {
  if (!vrDrag) return;

  vrDrag = null;

  drawTimeline(true);
  setStatus("Note moved to a new grid cell.", "success");
}

function setupController(index) {
  const controller = renderer.xr.getController(index);

  controller.userData.controllerIndex = index;
  scene.add(controller);

  const beamGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -5)
  ]);

  const beam = new THREE.Line(
    beamGeometry,
    new THREE.LineBasicMaterial({
      color: 0xaabaff,
      transparent: true,
      opacity: 0.72
    })
  );

  controller.add(beam);

  controller.addEventListener("selectstart", () => {
    handleControllerSelect(controller);
  });

  controller.addEventListener("squeezestart", () => {
    beginControllerDrag(controller);
  });

  controller.addEventListener("squeezeend", endControllerDrag);

  controller.addEventListener("connected", event => {
    controller.userData.gamepad =
      event.data?.gamepad || null;

    controller.userData.source = event.data || null;
  });

  controller.addEventListener("disconnected", () => {
    controller.userData.gamepad = null;
  });

  controllerObjects.push(controller);
}

setupController(0);
setupController(1);


// ------------------------------------------------------------
// Controller button polling
// ------------------------------------------------------------

function pollControllerButtons() {
  for (const controller of controllerObjects) {
    const gamepad = controller.userData.gamepad;

    if (!gamepad?.buttons) continue;

    let state = controllerButtonStates.get(controller);

    if (!state) {
      state = {
        rotate: false,
        color: false,
        deselect: false
      };

      controllerButtonStates.set(controller, state);
    }

    const deselectPressed = Boolean(gamepad.buttons[3]?.pressed);
    const rotatePressed = Boolean(gamepad.buttons[4]?.pressed);
    const colorPressed = Boolean(gamepad.buttons[5]?.pressed);

    if (deselectPressed && !state.deselect) {
      selectNote(null);
    }

    if (rotatePressed && !state.rotate && selectedNote()) {
      rotateSelected();
    }

    if (colorPressed && !state.color && selectedNote()) {
      const note = selectedNote();

      updateNote(note.id, {
        c: note.c === 0 ? 1 : 0
      });
    }

    // Thumbstick left/right adjusts the grid column.
    // Up/down adjusts beat time.
    const axes = gamepad.axes || [];

    const axisX = axes.length >= 4
      ? (axes[2] || 0)
      : (axes[0] || 0);

    const axisY = axes.length >= 4
      ? (axes[3] || 0)
      : (axes[1] || 0);

    const axisActive =
      Math.max(Math.abs(axisX), Math.abs(axisY)) > 0.72;

    const nowMs = performance.now();

    if (
      axisActive &&
      nowMs - (state.lastAxisAt || 0) > 260
    ) {
      state.lastAxisAt = nowMs;

      const step = Number($("snap").value) || 0.25;
      const note = selectedNote();

      if (Math.abs(axisY) > Math.abs(axisX)) {
        const delta = axisY < 0 ? step : -step;

        if (note) {
          updateNote(note.id, {
            b: Math.max(0, Number((note.b + delta).toFixed(4)))
          });
        } else {
          seekToBeat(Math.max(0, currentBeat() + delta));
        }
      } else if (note) {
        const nextX = Math.min(
          3,
          Math.max(0, note.x + (axisX > 0 ? 1 : -1))
        );

        updateNote(note.id, { x: nextX });
      }
    }

    state.deselect = deselectPressed;
    state.rotate = rotatePressed;
    state.color = colorPressed;
  }
}

function handleDesktopPointer(event) {
  if (renderer.xr.isPresenting) return;

  const rect = renderer.domElement.getBoundingClientRect();

  pointer.x =
    ((event.clientX - rect.left) / rect.width) * 2 - 1;

  pointer.y =
    -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(
    editorRoot.children,
    true
  );

  for (const hit of hits) {
    const target = resolveHitObject(hit.object);

    if (!target || !["note", "cell"].includes(target.userData.kind)) {
      continue;
    }

    if (target.userData.kind === "note") {
      selectNote(target.userData.id);
    } else if (target.userData.kind === "cell") {
      addNoteAt(
        target.userData.x,
        target.userData.y,
        currentBeat()
      );
    } else if (target.userData.kind === "difficulty") {
      switchDifficulty(target.userData.value);
    } else if (target.userData.kind === "action") {
      if (target.userData.value === "playpause") {
        togglePlayback();
      } else if (target.userData.value === "stop") {
        stopPlayback();
      }
    }

    return;
  }
}

renderer.domElement.addEventListener(
  "pointerdown",
  handleDesktopPointer
);

renderer.xr.addEventListener("sessionstart", () => {
  $("vrStatus").textContent = "VR session active";

  $("viewportHelp").textContent =
    "Aim at a grid cell and press trigger to place. Grab a cube with grip and point at another cell to move it.";
});

renderer.xr.addEventListener("sessionend", () => {
  $("vrStatus").textContent = "Desktop mode";

  endControllerDrag();
});

// Replace the placeholder button with Three.js's WebXR session button.
const xrButton = XRButton.createButton(
  renderer,
  {
    optionalFeatures: ["local-floor", "bounded-floor"]
  }
);

xrButton.id = "vrButton";
xrButton.className = "vr-button";
xrButton.textContent = "Enter VR";

$("vrButton").replaceWith(xrButton);

// ------------------------------------------------------------
// Project save / load
// ------------------------------------------------------------

function projectObject() {
  return {
    projectFormat: "vr-map-editor-project",
    projectVersion: 2,

    metadata: {
      title: $("songTitle").value,
      artist: $("songArtist").value,
      mapper: $("mapperName").value,
      bpm: bpm(),
      offset: offsetSeconds()
    },

    levels: cloneLevels(levels)
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

function saveProject() {
  const name = slugify(
    $("songTitle").value || "untitled-map"
  );

  const blob = new Blob(
    [JSON.stringify(projectObject(), null, 2)],
    { type: "application/json" }
  );

  downloadBlob(blob, `${name}.bsmapproject.json`);

  setStatus(
    "Project saved as JSON. Audio is not embedded, so re-import it when reopening the project.",
    "success"
  );
}

async function loadProject(file) {
  const parsed = JSON.parse(await file.text());

  if (
    parsed.projectFormat !== "vr-map-editor-project" ||
    !parsed.levels
  ) {
    throw new Error("This is not a VR Map Editor project file.");
  }

  const nextLevels = {};

  for (const name of DIFFICULTIES) {
    const items = Array.isArray(parsed.levels[name])
      ? parsed.levels[name]
      : [];

    nextLevels[name] = items.map(note => ({
      id: Number(note.id) || nextNoteId++,

      b: Math.max(
        0,
        Number(note.b) || 0
      ),

      x: Math.min(
        3,
        Math.max(0, Number(note.x) || 0)
      ),

      y: Math.min(
        2,
        Math.max(0, Number(note.y) || 0)
      ),

      c: Number(note.c) === 1 ? 1 : 0,

      d: Math.min(
        8,
        Math.max(0, Number(note.d) || 0)
      ),

      a: Number(note.a) || 0
    }));
  }

  pushUndo();

  levels = nextLevels;

  const allIds = Object.values(levels)
    .flat()
    .map(note => note.id);

  nextNoteId = Math.max(1, ...allIds) + 1;

  const meta = parsed.metadata || {};

  $("songTitle").value = meta.title || "Untitled Map";
  $("songArtist").value = meta.artist || "Unknown Artist";
  $("mapperName").value = meta.mapper || "Mapper";

  $("bpm").value =
    Number(meta.bpm) > 0 ? meta.bpm : 120;

  $("songOffset").value = Number(meta.offset) || 0;

  activeDifficulty = "Expert";
  selectedId = null;

  document.querySelectorAll("#difficultyGrid button").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.difficulty === activeDifficulty
    );
  });

  rebuildAllViews();

  setStatus(
    "Project loaded. Re-import the audio file to play or export a complete song.",
    "success"
  );
}

function slugify(value) {
  return String(value || "song")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "song";
}

// ------------------------------------------------------------
// OGG conversion and ZIP generation
// ------------------------------------------------------------

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    setStatus(
      "Loading audio converter. The single-thread FFmpeg WebAssembly core is about 31 MB and is downloaded on first conversion."
    );

    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import(
        "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js"
      ),

      import(
        "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js"
      )
    ]);

    const ffmpeg = new FFmpeg();

    const baseURL =
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

    ffmpeg.on("log", ({ message }) => {
      if (message && /error/i.test(message)) {
        setStatus(
          `Audio converter: ${message.slice(0, 180)}`
        );
      }
    });

    ffmpeg.on("progress", ({ progress }) => {
      if (Number.isFinite(progress)) {
        setStatus(
          `Converting audio to OGG · ${Math.round(progress * 100)}%`
        );
      }
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(
        `${baseURL}/ffmpeg-core.js`,
        "text/javascript"
      ),

      wasmURL: await toBlobURL(
        `${baseURL}/ffmpeg-core.wasm`,
        "application/wasm"
      )
    });

    ffmpegInstance = ffmpeg;

    return ffmpegInstance;
  })();

  try {
    return await ffmpegLoadPromise;
  } catch (error) {
    ffmpegLoadPromise = null;
    throw error;
  }
}

async function getOggAudio() {
  if (!audioFile) {
    throw new Error(
      "Import an audio file before exporting the song ZIP."
    );
  }

  const name = audioFile.name.toLowerCase();

  const signature = new Uint8Array(
    await audioFile.slice(0, 4).arrayBuffer()
  );

  const alreadyOgg =
    name.endsWith(".ogg") ||
    (
      signature[0] === 0x4f &&
      signature[1] === 0x67 &&
      signature[2] === 0x67 &&
      signature[3] === 0x53
    );

  if (alreadyOgg) {
    return new Uint8Array(
      await audioFile.arrayBuffer()
    );
  }

  const ffmpeg = await getFFmpeg();

  const ext = (
    name.match(/\.([a-z0-9]{1,8})$/)?.[1] || "audio"
  ).replace(/[^a-z0-9]/g, "");

  const inputName = `input.${ext}`;

  await ffmpeg.writeFile(
    inputName,
    new Uint8Array(await audioFile.arrayBuffer())
  );

  const result = await ffmpeg.exec([
    "-y",
    "-i",
    inputName,
    "-vn",
    "-c:a",
    "libvorbis",
    "-q:a",
    "5",
    "song.ogg"
  ]);

  if (result !== 0) {
    throw new Error(
      "FFmpeg could not convert this audio file to OGG Vorbis."
    );
  }

  const output = await ffmpeg.readFile("song.ogg");

  return output instanceof Uint8Array
    ? output
    : new Uint8Array(output);
}

// ------------------------------------------------------------
// ZIP file generation
// ------------------------------------------------------------

const crcTable = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) {
      c = (c & 1)
        ? (0xedb88320 ^ (c >>> 1))
        : (c >>> 1);
    }

    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;

  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const size = parts.reduce(
    (sum, part) => sum + part.length,
    0
  );

  const result = new Uint8Array(size);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function makeStoredZip(entries) {
  const encoder = new TextEncoder();

  const localParts = [];
  const centralParts = [];

  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);

    const data = typeof entry.data === "string"
      ? encoder.encode(entry.data)
      : entry.data;

    const checksum = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);

    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);

    local.set(name, 30);

    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);

    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, localOffset, true);

    central.set(name, 46);
    centralParts.push(central);

    localOffset += local.length + data.length;
  }

  const centralBytes = concatBytes(centralParts);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);

  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);

  return concatBytes([
    ...localParts,
    centralBytes,
    end
  ]);
}

function makeV3Beatmap(notes) {
  return {
    version: "3.3.0",

    bpmEvents: [],
    rotationEvents: [],

    colorNotes: notes
      .map(note => ({
        b: note.b,
        x: note.x,
        y: note.y,
        c: note.c,
        d: note.d,
        a: note.a || 0
      }))
      .sort((a, b) => a.b - b.b),

    bombNotes: [],
    obstacles: [],
    sliders: [],
    burstSliders: [],

    basicBeatmapEvents: [],
    colorBoostBeatmapEvents: [],
    waypoints: [],

    basicEventTypesWithKeywords: {
      d: []
    },

    lightColorEventBoxGroups: [],
    lightRotationEventBoxGroups: [],
    lightTranslationEventBoxGroups: [],
    vfxEventBoxGroups: [],

    useNormalEventsAsCompatibleEvents: false
  };
}

function makeInfoDat() {
  const difficultyBeatmaps = DIFFICULTIES
    .filter(name => Array.isArray(levels[name]))
    .map(name => ({
      _difficulty: name,
      _difficultyRank: RANKS[name],
      _beatmapFilename: `${name}Standard.dat`,

      _noteJumpMovementSpeed:
        name === "ExpertPlus"
          ? 16
          : name === "Expert"
            ? 14
            : 10,

      _noteJumpStartBeatOffset: 0,
      _environmentNameIdx: 0
    }));

  return {
    _version: "2.1.0",

    _songName:
      $("songTitle").value.trim() || "Untitled Map",

    _songSubName: "",

    _songAuthorName:
      $("songArtist").value.trim() || "Unknown Artist",

    _levelAuthorName:
      $("mapperName").value.trim() || "Mapper",

    _beatsPerMinute: bpm(),
    _songTimeOffset: offsetSeconds(),

    _shuffle: 0,
    _shufflePeriod: 0,

    _previewStartTime: 0,
    _previewDuration: 10,

    _songFilename: "song.ogg",
    _coverImageFilename: "",

    _environmentName: "DefaultEnvironment",
    _allDirectionsEnvironmentName: "GlassDesertEnvironment",

    _environmentNames: [
      "DefaultEnvironment",
      "GlassDesertEnvironment"
    ],

    _difficultyBeatmapSets: [
      {
        _beatmapCharacteristicName: "Standard",
        _difficultyBeatmaps: difficultyBeatmaps
      }
    ]
  };
}

async function exportSongZip() {
  if (!audioFile) {
    setStatus(
      "Import a song before exporting a complete Beat Saber ZIP.",
      "error"
    );

    return;
  }

  const button = $("exportBtn");
  button.disabled = true;

  const oldText = button.textContent;
  button.textContent = "Preparing…";

  try {
    const audioBytes = await getOggAudio();

    const entries = [
      {
        name: "Info.dat",
        data: JSON.stringify(makeInfoDat(), null, 2)
      }
    ];

    for (const name of DIFFICULTIES) {
      entries.push({
        name: `${name}Standard.dat`,
        data: JSON.stringify(
          makeV3Beatmap(levels[name]),
          null,
          2
        )
      });
    }

    entries.push({
      name: "song.ogg",
      data: audioBytes
    });

    setStatus("Building song ZIP…");

    const zipBytes = makeStoredZip(entries);

    const zipBlob = new Blob(
      [zipBytes],
      { type: "application/zip" }
    );

    const filename =
      `${slugify($("songTitle").value || "untitled-map")}.zip`;

    downloadBlob(zipBlob, filename);

    setStatus(
      `Exported ${filename} with Info.dat, five difficulties and OGG audio.`,
      "success",
      9000
    );

  } catch (error) {
    console.error(error);

    setStatus(
      `Export failed: ${error.message || error}`,
      "error",
      10000
    );

  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

// ------------------------------------------------------------
// Event wiring
// ------------------------------------------------------------

$("audioInput").addEventListener("change", event => {
  const file = event.target.files?.[0];

  if (file) {
    importAudio(file).catch(error => {
      setStatus(error.message, "error");
    });
  }

  event.target.value = "";
});

$("playBtn").onclick = togglePlayback;
$("stopBtn").onclick = stopPlayback;

$("audioSeek").oninput = event => {
  if (!audioElement || !audioDuration) return;

  const time =
    Number(event.target.value) / 1000 * audioDuration;

  audioElement.currentTime = time;

  manualBeat = Math.max(
    0,
    (time - offsetSeconds()) * bpm() / 60
  );

  updateTransportReadout();
  drawTimeline(true);
};

$("addNoteBtn").onclick = () => {
  addNoteAt(
    Number($("gridX").value),
    Number($("gridY").value),
    currentBeat()
  );
};

$("deleteNoteBtn").onclick = deleteSelected;
$("rotateNoteBtn").onclick = rotateSelected;
$("duplicateNoteBtn").onclick = duplicateSelected;
$("clearDifficultyBtn").onclick = clearCurrentDifficulty;
$("copyDownBtn").onclick = copyFromLowerDifficulty;

$("undoBtn").onclick = undo;
$("redoBtn").onclick = redo;

$("exportBtn").onclick = exportSongZip;
$("saveProjectBtn").onclick = saveProject;

$("loadProjectBtn").onclick = () => {
  $("projectFile").click();
};

$("projectFile").addEventListener("change", event => {
  const file = event.target.files?.[0];

  if (file) {
    loadProject(file).catch(error => {
      setStatus(error.message, "error");
    });
  }

  event.target.value = "";
});

$("metronomeBtn").onclick = toggleMetronome;

$("zoom").oninput = event => {
  timelineScale = Number(event.target.value);

  $("zoomValue").textContent =
    `${timelineScale} px/beat`;

  drawTimeline(true);
};

document.querySelectorAll("#difficultyGrid button").forEach(button => {
  button.addEventListener("click", () => {
    switchDifficulty(button.dataset.difficulty);
  });
});

$("bpm").addEventListener("change", () => {
  updateTransportReadout();
  drawTimeline(true);
});

$("songOffset").addEventListener("change", () => {
  updateTransportReadout();
  drawTimeline(true);
});

$("selectedBeatInput").addEventListener("change", event => {
  const note = selectedNote();

  if (!note) return;

  updateNote(note.id, {
    b: Number(
      Math.max(0, Number(event.target.value) || 0).toFixed(4)
    )
  });
});

$("selectedAngleInput").addEventListener("change", event => {
  const note = selectedNote();

  if (!note) return;

  updateNote(note.id, {
    a: Math.max(
      -180,
      Math.min(180, Number(event.target.value) || 0)
    )
  });
});

$("noteColor").addEventListener("change", event => {
  const note = selectedNote();

  if (note) {
    updateNote(note.id, {
      c: Number(event.target.value)
    });
  }
});

$("noteDirection").addEventListener("change", event => {
  const note = selectedNote();

  if (note) {
    updateNote(note.id, {
      d: Number(event.target.value)
    });
  }
});

$("gridX").addEventListener("change", event => {
  const note = selectedNote();

  if (note) {
    updateNote(note.id, {
      x: Number(event.target.value)
    });
  }
});

$("gridY").addEventListener("change", event => {
  const note = selectedNote();

  if (note) {
    updateNote(note.id, {
      y: Number(event.target.value)
    });
  }
});

// ------------------------------------------------------------
// Keyboard shortcuts
// ------------------------------------------------------------

window.addEventListener("keydown", event => {
  const tag = document.activeElement?.tagName;

  const typing =
    tag === "INPUT" ||
    tag === "SELECT" ||
    tag === "TEXTAREA";

  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "z"
  ) {
    event.preventDefault();
    undo();
    return;
  }

  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "y"
  ) {
    event.preventDefault();
    redo();
    return;
  }

  if (typing) return;

  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
  } else if (
    event.key === "Delete" ||
    event.key === "Backspace"
  ) {
    deleteSelected();
  } else if (event.key.toLowerCase() === "r") {
    rotateSelected();
  } else if (event.key.toLowerCase() === "d") {
    duplicateSelected();
  } else if (
    event.key === "ArrowLeft" &&
    selectedNote()
  ) {
    updateNote(selectedId, {
      b: Math.max(
        0,
        selectedNote().b -
          (Number($("snap").value) || 0.25)
      )
    });
  } else if (
    event.key === "ArrowRight" &&
    selectedNote()
  ) {
    updateNote(selectedId, {
      b: selectedNote().b +
        (Number($("snap").value) || 0.25)
    });
  }
});

// ------------------------------------------------------------
// Render loop and resize
// ------------------------------------------------------------

function resizeRenderer() {
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height, false);
}

window.addEventListener("resize", resizeRenderer);

const resizeObserver = new ResizeObserver(resizeRenderer);
resizeObserver.observe(viewport);

resizeRenderer();

renderer.setAnimationLoop(() => {
  if (audioElement) {
    if (audioElement.ended) {
      $("playBtn").textContent = "▶ Play";
      refreshVrControls();
    }

    updateTransportReadout();
    updateMetronome();
  }

  updateVrBeatReadout();
  updateEditorNoteVisibility();

  if (vrDrag) {
    updateControllerDrag();
  }

  pollControllerButtons();
  updateIncomingPreview();
  drawTimeline();

  renderer.render(scene, camera);
});

// ------------------------------------------------------------
// Initial UI state
// ------------------------------------------------------------

updateHistoryButtons();
rebuildAllViews();
updateTransportReadout();

setStatus(
  "Ready. Import audio, set BPM, then place notes at the playhead."
);
