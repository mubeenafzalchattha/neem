const $ = (id) => document.getElementById(id);

/* ==================================================================== *
 * State
 * ==================================================================== */

const state = {
  isRecording: false,
  isPaused: false,

  cameraEnabled: true,
  micEnabled: true,
  zoomEnabled: true,

  // what we are capturing
  capture: {
    mode: 'screen',          // 'screen' | 'window' | 'region'
    sourceId: null,          // desktopCapturer source id
    label: 'Full screen',
    display: null,           // { id, bounds, scaleFactor } for screen/region
    region: null             // { x, y, width, height } in screen DIP
  },

  // timing
  startedAt: null,
  elapsedMs: 0,
  timerInterval: null,

  // media
  recordingMimeType: 'video/webm',
  captureStream: null,       // raw desktop stream
  canvasStream: null,        // composited stream that gets recorded
  micStream: null,
  cameraStream: null,
  recorder: null,
  chunks: [],

  // canvas pipeline
  crop: { x: 0, y: 0, width: 0, height: 0 },
  output: { width: 0, height: 0 },
  pxPerDip: 1,
  rafId: null,

  // cursor + zoom
  cursor: { x: 0, y: 0, stillMs: 0, travelled: 0 },
  zoom: {
    current: 1,
    target: 1,
    manual: null,
    autoUntil: 0,
    cx: 0,
    cy: 0,
    targetCx: 0,
    targetCy: 0
  },

  // library
  recordings: [],
  recordingsFolder: '',

  // picker
  sources: { screens: [], windows: [], displays: [], primaryDisplayId: '' },
  pickerTab: 'screens',

  finalizingStop: false,
  stopTimeoutId: null,
  panelScale: 0.78,
  disposers: []
};

const PANEL_SCALE_MIN = 0.7;
const PANEL_SCALE_MAX = 1.1;

const ZOOM_AUTO_LEVEL = 1.85;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.4;
const ZOOM_EASE = 0.11;
const PAN_EASE = 0.14;
const AUTO_HOLD_MS = 2400;

/* ==================================================================== *
 * Small helpers
 * ==================================================================== */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function setStatus(text) {
  $('status').textContent = text;
}

function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatWhen(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (yesterday) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function prettyName(name) {
  return name.replace(/^neem-/, '').replace(/\.(mp4|webm|mov)$/i, '');
}

/* ==================================================================== *
 * View switching
 * ==================================================================== */

function showView(name) {
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('active', view.id === name);
  }
  keepElementInViewport($('recorderView'));
}

/* ==================================================================== *
 * Home / recordings library
 * ==================================================================== */

function renderRecordings() {
  const list = $('recordingList');
  const count = $('homeCount');
  list.innerHTML = '';

  if (!state.recordings.length) {
    count.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<strong>Nothing recorded yet</strong>Your recordings will show up here, saved automatically as MP4.';
    list.appendChild(empty);
    return;
  }

  count.textContent = `${state.recordings.length} ${state.recordings.length === 1 ? 'clip' : 'clips'}`;

  for (const item of state.recordings) {
    const row = document.createElement('div');
    row.className = 'rec-item';
    row.title = item.name;

    const thumb = document.createElement('div');
    thumb.className = 'rec-thumb';
    if (item.thumbnail) {
      thumb.style.backgroundImage = `url("${item.thumbnail}")`;
    } else {
      thumb.textContent = '\u{1F343}';
    }

    const meta = document.createElement('div');
    meta.className = 'rec-meta';

    const nameEl = document.createElement('div');
    nameEl.className = 'rec-name';
    nameEl.textContent = prettyName(item.name);

    const subEl = document.createElement('div');
    subEl.className = 'rec-sub';
    const bits = [formatWhen(item.createdAt)];
    if (item.durationMs) bits.push(formatMs(item.durationMs));
    if (item.size) bits.push(formatBytes(item.size));
    subEl.textContent = bits.filter(Boolean).join('  ·  ');

    meta.appendChild(nameEl);
    meta.appendChild(subEl);

    const actions = document.createElement('div');
    actions.className = 'rec-actions';

    const revealBtn = document.createElement('button');
    revealBtn.className = 'rec-action';
    revealBtn.type = 'button';
    revealBtn.title = 'Show in Finder';
    revealBtn.textContent = '\u{1F4C1}';
    revealBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      window.loomBridge.revealRecording(item.path);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'rec-action';
    deleteBtn.type = 'button';
    deleteBtn.title = 'Move to Trash';
    deleteBtn.textContent = '\u{1F5D1}';
    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const ok = window.confirm(`Move "${prettyName(item.name)}" to the Trash?`);
      if (!ok) return;
      await window.loomBridge.deleteRecording(item.path);
      await loadRecordings();
    });

    actions.appendChild(revealBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(thumb);
    row.appendChild(meta);
    row.appendChild(actions);
    row.addEventListener('click', () => window.loomBridge.openRecording(item.path));

    list.appendChild(row);
  }
}

async function loadRecordings() {
  try {
    const result = await window.loomBridge.listRecordings();
    state.recordings = result.recordings || [];
    state.recordingsFolder = result.folder || '';
    renderRecordings();
  } catch (error) {
    console.error('Failed to load recordings', error);
  }
}

/* ==================================================================== *
 * Capture source picker
 * ==================================================================== */

function captureLabel() {
  const { mode, label, region } = state.capture;
  if (mode === 'region' && region) {
    return `${Math.round(region.width)}×${Math.round(region.height)}`;
  }
  return label;
}

function renderCaptureRow() {
  $('captureRight').innerHTML = `<span class="tag">${captureLabel()}</span>`;
}

function openSourcePicker() {
  if (state.isRecording) return;
  const overlay = $('sourceOverlay');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  setWindowPassThrough(false);
  loadSources();
}

function closeSourcePicker() {
  const overlay = $('sourceOverlay');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  setWindowPassThrough(true);
}

async function loadSources() {
  const grid = $('sourceGrid');
  grid.innerHTML = '<div class="source-empty">Loading…</div>';
  try {
    state.sources = await window.loomBridge.getCaptureSources();
  } catch (error) {
    grid.innerHTML = `<div class="source-empty">Could not read screen sources.<br>${error.message}</div>`;
    return;
  }
  renderSourceGrid();
}

function renderSourceGrid() {
  const grid = $('sourceGrid');
  const regionPane = $('regionPane');

  if (state.pickerTab === 'region') {
    grid.style.display = 'none';
    regionPane.style.display = 'block';
    return;
  }

  grid.style.display = 'grid';
  regionPane.style.display = 'none';
  grid.innerHTML = '';

  const items = state.pickerTab === 'screens' ? state.sources.screens : state.sources.windows;

  if (!items || !items.length) {
    grid.innerHTML = '<div class="source-empty">Nothing available here.</div>';
    return;
  }

  for (const source of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'source-card';
    if (state.capture.sourceId === source.id && state.capture.mode !== 'region') {
      card.classList.add('selected');
    }

    const thumb = document.createElement('div');
    thumb.className = 'source-thumb';
    if (source.thumbnail) {
      thumb.style.backgroundImage = `url("${source.thumbnail}")`;
    } else {
      thumb.textContent = state.pickerTab === 'screens' ? '\u{1F5A5}' : '\u{1FA9F}';
    }

    const name = document.createElement('div');
    name.className = 'source-name';
    name.textContent = source.name || 'Untitled';

    card.appendChild(thumb);
    card.appendChild(name);
    card.addEventListener('click', () => {
      selectSource(source, state.pickerTab === 'screens' ? 'screen' : 'window');
    });

    grid.appendChild(card);
  }
}

function selectSource(source, mode) {
  state.capture = {
    mode,
    sourceId: source.id,
    label: mode === 'screen' ? (source.name || 'Display') : (source.name || 'Window'),
    display: source.display || null,
    region: null
  };
  renderCaptureRow();
  renderSourceGrid();
  closeSourcePicker();
  setStatus(mode === 'screen' ? `Recording ${state.capture.label}` : `Recording window: ${state.capture.label}`);
}

async function defaultToPrimaryScreen() {
  try {
    const sources = await window.loomBridge.getCaptureSources();
    state.sources = sources;
    const primary = sources.screens.find(
      (s) => String(s.displayId) === String(sources.primaryDisplayId)
    ) || sources.screens[0];
    if (primary) {
      state.capture = {
        mode: 'screen',
        sourceId: primary.id,
        label: sources.screens.length > 1 ? (primary.name || 'Display 1') : 'Full screen',
        display: primary.display || null,
        region: null
      };
      renderCaptureRow();
    }
  } catch (error) {
    console.error('Could not pre-select a display', error);
  }
}

/* ==================================================================== *
 * Region selector
 * ==================================================================== */

let regionDrag = null;

function beginRegionSelection() {
  closeSourcePicker();
  const layer = $('regionLayer');
  layer.classList.add('open');
  $('regionBox').style.display = 'none';
  $('regionSize').style.display = 'none';
  setWindowPassThrough(false);
}

function endRegionSelection() {
  $('regionLayer').classList.remove('open');
  $('regionLayer').classList.remove('drawing');
  $('regionBox').style.display = 'none';
  $('regionSize').style.display = 'none';
  regionDrag = null;
  setWindowPassThrough(true);
}

function bindRegionSelector() {
  const layer = $('regionLayer');
  const box = $('regionBox');
  const sizeTag = $('regionSize');

  layer.addEventListener('pointerdown', (event) => {
    regionDrag = { x: event.clientX, y: event.clientY };
    layer.setPointerCapture(event.pointerId);
    layer.classList.add('drawing');
    box.style.display = 'block';
    sizeTag.style.display = 'block';
  });

  layer.addEventListener('pointermove', (event) => {
    if (!regionDrag) return;
    const x = Math.min(regionDrag.x, event.clientX);
    const y = Math.min(regionDrag.y, event.clientY);
    const w = Math.abs(event.clientX - regionDrag.x);
    const h = Math.abs(event.clientY - regionDrag.y);
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    sizeTag.style.left = `${x + w / 2}px`;
    sizeTag.style.top = `${y}px`;
    sizeTag.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  });

  layer.addEventListener('pointerup', (event) => {
    if (!regionDrag) return;
    const x = Math.min(regionDrag.x, event.clientX);
    const y = Math.min(regionDrag.y, event.clientY);
    const w = Math.abs(event.clientX - regionDrag.x);
    const h = Math.abs(event.clientY - regionDrag.y);
    endRegionSelection();

    if (w < 60 || h < 60) {
      setStatus('Region too small — try dragging a bigger box');
      return;
    }

    const primary =
      state.sources.displays.find((d) => String(d.id) === String(state.sources.primaryDisplayId)) ||
      state.sources.displays[0] ||
      null;

    const screenSource =
      state.sources.screens.find(
        (s) => String(s.displayId) === String(state.sources.primaryDisplayId)
      ) || state.sources.screens[0];

    if (!screenSource) {
      setStatus('No display source available for region capture');
      return;
    }

    state.capture = {
      mode: 'region',
      sourceId: screenSource.id,
      label: 'Custom region',
      display: screenSource.display || primary,
      region: { x, y, width: w, height: h }
    };

    renderCaptureRow();
    setStatus(`Region set: ${Math.round(w)}×${Math.round(h)}`);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && layer.classList.contains('open')) {
      endRegionSelection();
      setStatus('Region selection cancelled');
    }
  });
}

/* ==================================================================== *
 * Permissions
 * ==================================================================== */

function friendlyPermissionName(type) {
  if (type === 'screen') return 'Screen Recording';
  if (type === 'camera') return 'Camera';
  return 'Microphone';
}

function rowForPermission(type) {
  if (type === 'camera') return 'cameraRight';
  if (type === 'microphone') return 'microphoneRight';
  return 'captureRight';
}

function setLoading(targetId) {
  const target = $(targetId);
  if (target) target.innerHTML = '<span class="loader"></span>';
}

function setSwitch(targetId, on) {
  const target = $(targetId);
  if (!target) return;
  target.innerHTML = `<span class="switch ${on ? '' : 'off'}">${on ? 'On' : 'Off'}</span>`;
}

async function requirePermission(type, requestIfPossible = true) {
  const targetId = rowForPermission(type);
  setLoading(targetId);

  let permissions = await window.loomBridge.checkPermissions();
  let status = permissions[type];

  if (
    requestIfPossible &&
    (type === 'camera' || type === 'microphone') &&
    status === 'not-determined'
  ) {
    await window.loomBridge.requestMediaPermission(type);
    permissions = await window.loomBridge.checkPermissions();
    status = permissions[type];
  }

  if (type === 'camera') setSwitch(targetId, state.cameraEnabled);
  else if (type === 'microphone') setSwitch(targetId, state.micEnabled);
  else renderCaptureRow();

  if (status === 'granted') return true;

  setStatus(`${friendlyPermissionName(type)} permission needed`);
  const open = window.confirm(`${friendlyPermissionName(type)} permission is required. Open settings now?`);
  if (open) await window.loomBridge.openPermissionSettings(type);
  return false;
}

/* ==================================================================== *
 * Camera
 * ==================================================================== */

function stopCameraPreview() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  $('cameraPreview').srcObject = null;
  $('cameraBubble').style.display = 'none';
}

async function startCameraPreview() {
  if (!state.cameraEnabled) return false;
  state.cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 640 } },
    audio: false
  });
  $('cameraPreview').srcObject = state.cameraStream;
  $('cameraBubble').style.display = 'block';
  return true;
}

/* ==================================================================== *
 * Capture + canvas composer
 * ==================================================================== */

async function openCaptureStream() {
  if (!state.capture.sourceId) {
    await defaultToPrimaryScreen();
  }
  if (!state.capture.sourceId) {
    throw new Error('No capture source selected');
  }

  // Preferred path: the legacy desktop constraints give us the exact source
  // with no picker UI. If a future Electron drops them, fall back to
  // getDisplayMedia, which the main process answers with the same source.
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: state.capture.sourceId,
          minFrameRate: 30,
          maxFrameRate: 60,
          maxWidth: 3840,
          maxHeight: 2160
        }
      }
    });
  } catch (legacyError) {
    console.warn('Legacy desktop capture failed, trying getDisplayMedia:', legacyError);
    await window.loomBridge.setPendingSource(state.capture.sourceId);
    return navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: { ideal: 30, max: 60 } }
    });
  }
}

function waitForVideoReady(video) {
  return new Promise((resolve, reject) => {
    if (video.videoWidth && video.videoHeight) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the capture stream')), 8000);
    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

function computeCropAndOutput(videoWidth, videoHeight) {
  const { mode, display, region } = state.capture;

  let crop = { x: 0, y: 0, width: videoWidth, height: videoHeight };
  state.pxPerDip = 1;

  if (display && display.bounds && display.bounds.width) {
    state.pxPerDip = videoWidth / display.bounds.width;
  }

  if (mode === 'region' && region && display) {
    const scale = state.pxPerDip;
    let x = Math.round((region.x - 0) * scale);
    let y = Math.round((region.y - 0) * scale);
    let w = Math.round(region.width * scale);
    let h = Math.round(region.height * scale);

    x = clamp(x, 0, Math.max(0, videoWidth - 2));
    y = clamp(y, 0, Math.max(0, videoHeight - 2));
    w = clamp(w, 2, videoWidth - x);
    h = clamp(h, 2, videoHeight - y);

    crop = { x, y, width: w, height: h };
  }

  // Output: cap the long edge so encoding stays fast, keep even dimensions.
  const MAX_WIDTH = 1920;
  let outW = crop.width;
  let outH = crop.height;
  if (outW > MAX_WIDTH) {
    outH = Math.round((MAX_WIDTH / outW) * outH);
    outW = MAX_WIDTH;
  }
  outW = Math.max(2, outW - (outW % 2));
  outH = Math.max(2, outH - (outH % 2));

  state.crop = crop;
  state.output = { width: outW, height: outH };
}

function resetZoomState() {
  state.zoom.current = 1;
  state.zoom.target = 1;
  state.zoom.manual = null;
  state.zoom.autoUntil = 0;
  state.zoom.cx = state.crop.x + state.crop.width / 2;
  state.zoom.cy = state.crop.y + state.crop.height / 2;
  state.zoom.targetCx = state.zoom.cx;
  state.zoom.targetCy = state.zoom.cy;
}

function cursorInSourcePixels() {
  const display = state.capture.display;
  if (!display || !display.bounds || state.capture.mode === 'window') return null;
  return {
    x: (state.cursor.x - display.bounds.x) * state.pxPerDip,
    y: (state.cursor.y - display.bounds.y) * state.pxPerDip
  };
}

function currentZoomTarget() {
  if (state.zoom.manual !== null) return state.zoom.manual;
  if (state.zoomEnabled && Date.now() < state.zoom.autoUntil) return ZOOM_AUTO_LEVEL;
  return 1;
}

function drawCameraBubble(ctx) {
  const cam = $('cameraPreview');
  if (!state.cameraEnabled || !cam || cam.readyState < 2 || !cam.videoWidth) return;

  const bubble = $('cameraBubble');
  const rect = bubble.getBoundingClientRect();
  const fx = clamp((rect.left + rect.width / 2) / window.innerWidth, 0, 1);
  const fy = clamp((rect.top + rect.height / 2) / window.innerHeight, 0, 1);

  const radius = Math.round(state.output.height * 0.145);
  const margin = Math.round(radius * 0.35);
  const cx = clamp(fx * state.output.width, radius + margin, state.output.width - radius - margin);
  const cy = clamp(fy * state.output.height, radius + margin, state.output.height - radius - margin);

  const scale = Math.max((radius * 2) / cam.videoWidth, (radius * 2) / cam.videoHeight);
  const dw = cam.videoWidth * scale;
  const dh = cam.videoHeight * scale;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1);
  ctx.drawImage(cam, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, radius * 0.05);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.stroke();
  ctx.restore();
}

function startComposerLoop() {
  const video = $('sourceVideo');
  const canvas = $('composer');
  canvas.width = state.output.width;
  canvas.height = state.output.height;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const crop = state.crop;

  const draw = () => {
    state.rafId = requestAnimationFrame(draw);
    if (video.readyState < 2) return;

    // ease zoom level
    state.zoom.target = currentZoomTarget();
    state.zoom.current = lerp(state.zoom.current, state.zoom.target, ZOOM_EASE);
    if (Math.abs(state.zoom.current - state.zoom.target) < 0.002) {
      state.zoom.current = state.zoom.target;
    }

    const z = Math.max(1, state.zoom.current);
    const sw = crop.width / z;
    const sh = crop.height / z;

    // ease pan toward the pointer (or stay centred when we cannot map it)
    const pointer = cursorInSourcePixels();
    if (pointer && z > 1.001) {
      state.zoom.targetCx = pointer.x;
      state.zoom.targetCy = pointer.y;
    } else if (z <= 1.001) {
      state.zoom.targetCx = crop.x + crop.width / 2;
      state.zoom.targetCy = crop.y + crop.height / 2;
    }

    state.zoom.cx = lerp(state.zoom.cx, state.zoom.targetCx, PAN_EASE);
    state.zoom.cy = lerp(state.zoom.cy, state.zoom.targetCy, PAN_EASE);

    const sx = clamp(state.zoom.cx - sw / 2, crop.x, crop.x + crop.width - sw);
    const sy = clamp(state.zoom.cy - sh / 2, crop.y, crop.y + crop.height - sh);

    try {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, state.output.width, state.output.height);
    } catch (_error) {
      return;
    }

    drawCameraBubble(ctx);
  };

  draw();
}

function stopComposerLoop() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

/* ==================================================================== *
 * Zoom controls
 * ==================================================================== */

function zoomIn() {
  const base = state.zoom.manual !== null ? state.zoom.manual : Math.max(1, state.zoom.current);
  state.zoom.manual = clamp(Number((base + ZOOM_STEP).toFixed(2)), 1, ZOOM_MAX);
  updateZoomButtons();
  setStatus(`Zoom ${state.zoom.manual.toFixed(1)}×`);
}

function zoomOut() {
  const base = state.zoom.manual !== null ? state.zoom.manual : Math.max(1, state.zoom.current);
  const next = clamp(Number((base - ZOOM_STEP).toFixed(2)), 1, ZOOM_MAX);
  state.zoom.manual = next <= 1.001 ? null : next;
  if (state.zoom.manual === null) {
    state.zoom.autoUntil = 0;
    setStatus(state.zoomEnabled ? 'Zoom back to auto' : 'Zoom off');
  } else {
    setStatus(`Zoom ${state.zoom.manual.toFixed(1)}×`);
  }
  updateZoomButtons();
}

function updateZoomButtons() {
  const zoomed = state.zoom.manual !== null || state.zoom.current > 1.05;
  $('miniZoomInBtn').classList.toggle('active', state.zoom.manual !== null && state.zoom.manual >= ZOOM_MAX);
  $('miniZoomOutBtn').classList.toggle('active', false);
  $('miniZoomInBtn').title = zoomed
    ? `Zoom in (now ${(state.zoom.manual ?? state.zoom.current).toFixed(1)}×)`
    : 'Zoom in (Cmd+Shift+Z)';
}

function toggleZoomFeature() {
  if (state.isRecording) return;
  state.zoomEnabled = !state.zoomEnabled;
  setSwitch('zoomRight', state.zoomEnabled);
  setStatus(state.zoomEnabled ? 'Cursor zoom on' : 'Cursor zoom off');
}

/* ==================================================================== *
 * Timer + UI state
 * ==================================================================== */

function elapsedNow() {
  return state.isRecording && !state.isPaused
    ? Date.now() - state.startedAt + state.elapsedMs
    : state.elapsedMs;
}

function updateTimerDisplay() {
  const text = formatMs(elapsedNow());
  $('liveTimer').textContent = text;
  $('miniTimer').textContent = text;
}

function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimerDisplay, 200);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function switchPill(on) {
  for (const dot of document.querySelectorAll('.dot')) {
    dot.style.opacity = on ? '1' : '0.35';
  }
}

function setPauseIcon() {
  $('miniPauseBtn').innerHTML = state.isPaused ? '&#9654;' : '&#9208;';
}

function setUiState() {
  $('recordBtn').textContent = state.isRecording ? 'STOP' : 'START';
  setSwitch('cameraRight', state.cameraEnabled);
  setSwitch('microphoneRight', state.micEnabled);
  setSwitch('zoomRight', state.zoomEnabled);
  renderCaptureRow();
  setPauseIcon();
  updateZoomButtons();

  const card = $('recorderView');
  card.classList.toggle('mini', state.isRecording);
  if (!state.isRecording) state.isPaused = false;
  keepElementInViewport(card);
}

/* ==================================================================== *
 * Recording
 * ==================================================================== */

function createRecorder(stream) {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
    ''
  ];

  const selected = candidates.find((c) => !c || MediaRecorder.isTypeSupported(c)) || '';
  state.recordingMimeType = selected || 'video/webm';

  try {
    return selected
      ? new MediaRecorder(stream, { mimeType: selected, videoBitsPerSecond: 6000000 })
      : new MediaRecorder(stream);
  } catch (_error) {
    return new MediaRecorder(stream);
  }
}

function resetMediaResources() {
  stopComposerLoop();

  if (state.captureStream) state.captureStream.getTracks().forEach((t) => t.stop());
  if (state.canvasStream) state.canvasStream.getTracks().forEach((t) => t.stop());
  if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
  stopCameraPreview();

  state.captureStream = null;
  state.canvasStream = null;
  state.micStream = null;
  $('sourceVideo').srcObject = null;

  window.loomBridge.stopCursorTracking();
  window.loomBridge.unregisterRecordingShortcuts();
  window.loomBridge.setContentProtection(false);
}

async function startRecording() {
  const hasScreen = await requirePermission('screen', false);
  if (!hasScreen) return;

  if (state.micEnabled) {
    const micAllowed = await requirePermission('microphone', true);
    if (!micAllowed) {
      state.micEnabled = false;
      setSwitch('microphoneRight', false);
    }
  }

  if (state.cameraEnabled) {
    const camAllowed = await requirePermission('camera', true);
    if (!camAllowed) {
      state.cameraEnabled = false;
      setSwitch('cameraRight', false);
    }
  }

  setStatus('Preparing capture…');

  state.captureStream = await openCaptureStream();

  const video = $('sourceVideo');
  video.srcObject = state.captureStream;
  try { await video.play(); } catch (_error) {}
  await waitForVideoReady(video);

  computeCropAndOutput(video.videoWidth, video.videoHeight);
  resetZoomState();

  if (state.micEnabled) {
    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
    } catch (_error) {
      state.micEnabled = false;
      setSwitch('microphoneRight', false);
      setStatus('Microphone unavailable, continuing without it');
    }
  }

  if (state.cameraEnabled) {
    try {
      await startCameraPreview();
    } catch (_error) {
      state.cameraEnabled = false;
      setSwitch('cameraRight', false);
      setStatus('Camera unavailable, continuing without it');
    }
  }

  // Keep the Neem UI out of the recording; the camera bubble is composited in.
  await window.loomBridge.setContentProtection(true);

  startComposerLoop();

  const canvas = $('composer');
  state.canvasStream = canvas.captureStream(30);
  if (state.micStream) {
    for (const track of state.micStream.getAudioTracks()) {
      state.canvasStream.addTrack(track);
    }
  }

  state.chunks = [];
  state.finalizingStop = false;
  state.recorder = createRecorder(state.canvasStream);

  state.recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) state.chunks.push(event.data);
  };

  state.recorder.onstop = async () => {
    await finalizeStop('normal');
  };

  const sourceTrack = state.captureStream.getVideoTracks()[0];
  if (sourceTrack) {
    sourceTrack.onended = () => {
      if (state.isRecording && state.recorder && state.recorder.state !== 'inactive') {
        state.recorder.stop();
      }
    };
  }

  state.recorder.start(300);
  state.startedAt = Date.now();
  state.elapsedMs = 0;
  state.isPaused = false;
  state.isRecording = true;

  await window.loomBridge.startCursorTracking(16);
  await window.loomBridge.registerRecordingShortcuts();

  setUiState();
  switchPill(true);
  startTimer();
  updateTimerDisplay();
  setStatus('Recording…');
}

function togglePauseResume() {
  if (!state.isRecording || !state.recorder) return;

  if (!state.isPaused) {
    state.recorder.pause();
    state.elapsedMs += Date.now() - state.startedAt;
    state.isPaused = true;
    setStatus(`Paused at ${formatMs(state.elapsedMs)}`);
  } else {
    state.recorder.resume();
    state.startedAt = Date.now();
    state.isPaused = false;
    setStatus('Recording resumed');
  }

  setPauseIcon();
  updateTimerDisplay();
}

function stopRecording() {
  if (!state.isRecording || !state.recorder) return;
  setStatus('Stopping…');

  if (state.recorder.state === 'paused') {
    state.recorder.resume();
    state.isPaused = false;
  }

  try { state.recorder.requestData(); } catch (_error) {}
  if (state.recorder.state !== 'inactive') state.recorder.stop();

  state.stopTimeoutId = setTimeout(() => finalizeStop('forced'), 5000);
}

async function finalizeStop(reason = 'normal') {
  if (state.finalizingStop) return;
  state.finalizingStop = true;

  const durationMs = elapsedNow();

  resetMediaResources();

  if (state.stopTimeoutId) {
    clearTimeout(state.stopTimeoutId);
    state.stopTimeoutId = null;
  }

  switchPill(false);
  stopTimer();

  state.isRecording = false;
  state.isPaused = false;
  setUiState();
  showView('homeView');
  setStatus('Processing video…');

  try {
    if (state.chunks.length > 0) {
      const blob = new Blob(state.chunks, { type: state.recordingMimeType || 'video/webm' });
      const arrayBuffer = await blob.arrayBuffer();

      const result = await window.loomBridge.saveRecording({
        buffer: new Uint8Array(arrayBuffer),
        durationMs,
        mode: state.capture.mode
      });

      await loadRecordings();
      setStatus(result.warning || (result.format === 'mp4' ? 'Saved to Movies › Neem' : 'Saved'));
    } else if (reason === 'forced') {
      setStatus('Stopped, but no video data was captured');
    }
  } catch (error) {
    setStatus(`Could not save: ${error.message}`);
  } finally {
    state.recorder = null;
    state.chunks = [];
    state.elapsedMs = 0;
    state.startedAt = null;
    state.finalizingStop = false;
    updateTimerDisplay();
  }
}

async function onRecordClick() {
  if (!state.isRecording) {
    try {
      await startRecording();
    } catch (error) {
      const details = error && error.name ? `${error.name}: ${error.message}` : String(error);
      setStatus(`Error: ${details}`);
      switchPill(false);
      stopTimer();
      state.isRecording = false;
      state.isPaused = false;
      resetMediaResources();
      setUiState();
    }
    return;
  }
  stopRecording();
}

function toggleCamera() {
  if (state.isRecording) return;
  state.cameraEnabled = !state.cameraEnabled;
  setSwitch('cameraRight', state.cameraEnabled);
  setStatus(state.cameraEnabled ? 'Camera enabled' : 'Camera disabled');
}

function toggleMic() {
  if (state.isRecording) return;
  state.micEnabled = !state.micEnabled;
  setSwitch('microphoneRight', state.micEnabled);
  setStatus(state.micEnabled ? 'Microphone enabled' : 'Microphone disabled');
}

/* ==================================================================== *
 * Window chrome: dragging, pass-through, overlays
 * ==================================================================== */

function keepElementInViewport(element) {
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const left = parseFloat(element.style.left || '0');
  const top = parseFloat(element.style.top || '0');
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  element.style.left = `${clamp(left, 0, maxLeft)}px`;
  element.style.top = `${clamp(top, 0, maxTop)}px`;
}

function applyPanelScale(scale) {
  const card = $('recorderView');
  const next = clamp(scale, PANEL_SCALE_MIN, PANEL_SCALE_MAX);
  state.panelScale = next;
  card.style.transform = `scale(${next})`;
  card.style.transformOrigin = 'top left';
  keepElementInViewport(card);
}

async function setWindowPassThrough(enabled) {
  try {
    await window.loomBridge.setIgnoreMouseEvents(enabled);
  } catch (_error) {}
}

function makeDraggable(element, blockedSelector) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  element.addEventListener('pointerdown', async (event) => {
    if (blockedSelector && event.target.closest(blockedSelector)) return;
    dragging = true;
    element.classList.add('dragging');
    const rect = element.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    element.setPointerCapture(event.pointerId);
    await setWindowPassThrough(false);
  });

  element.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = element.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width;
    const maxTop = window.innerHeight - rect.height;
    element.style.left = `${clamp(event.clientX - offsetX, 0, maxLeft)}px`;
    element.style.top = `${clamp(event.clientY - offsetY, 0, maxTop)}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  });

  const endDrag = async () => {
    if (!dragging) return;
    dragging = false;
    element.classList.remove('dragging');
    await setWindowPassThrough(false);
  };

  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);
}

function initializeWidgetPositions() {
  const card = $('recorderView');
  const cam = $('cameraBubble');
  const cardRect = card.getBoundingClientRect();
  card.style.left = `${Math.max(0, window.innerWidth - cardRect.width - 20)}px`;
  card.style.top = '20px';
  card.style.right = 'auto';

  const camSize = 138;
  cam.style.left = '20px';
  cam.style.top = `${window.innerHeight - camSize - 20}px`;
  cam.style.bottom = 'auto';
}

function bindOverlayInteractivity() {
  const onEnter = () => setWindowPassThrough(false);
  const onLeave = () => {
    const anyOverlayOpen = document.querySelector('.overlay.open') ||
      $('regionLayer').classList.contains('open');
    if (!anyOverlayOpen) setWindowPassThrough(true);
  };

  for (const selector of ['.card', '.camera-bubble']) {
    const element = document.querySelector(selector);
    if (!element) continue;
    element.addEventListener('mouseenter', onEnter);
    element.addEventListener('mouseleave', onLeave);
  }

  setWindowPassThrough(true);
}

function openInfoModal() {
  const overlay = $('infoOverlay');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  setWindowPassThrough(false);
}

function closeInfoModal() {
  const overlay = $('infoOverlay');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  setWindowPassThrough(true);
}

/* ==================================================================== *
 * Wiring
 * ==================================================================== */

function bindEvents() {
  // home
  $('newRecordingBtn').addEventListener('click', () => {
    showView('setupView');
    setStatus('Ready');
  });
  $('openFolderBtn').addEventListener('click', () => window.loomBridge.openRecordingsFolder());
  $('backHomeBtn').addEventListener('click', () => {
    if (state.isRecording) return;
    showView('homeView');
    loadRecordings();
  });

  // recorder rows
  $('captureItem').addEventListener('click', openSourcePicker);
  $('zoomItem').addEventListener('click', toggleZoomFeature);
  $('cameraItem').addEventListener('click', toggleCamera);
  $('microphoneItem').addEventListener('click', toggleMic);
  $('recordBtn').addEventListener('click', onRecordClick);

  // mini controls
  $('miniStopBtn').addEventListener('click', onRecordClick);
  $('miniPauseBtn').addEventListener('click', togglePauseResume);
  $('miniZoomInBtn').addEventListener('click', zoomIn);
  $('miniZoomOutBtn').addEventListener('click', zoomOut);

  // source picker
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.pickerTab = tab.dataset.tab;
      for (const other of document.querySelectorAll('.tab')) {
        other.classList.toggle('active', other === tab);
      }
      renderSourceGrid();
    });
  }
  $('startRegionBtn').addEventListener('click', beginRegionSelection);
  $('closeSourceBtn').addEventListener('click', closeSourcePicker);
  $('sourceOverlay').addEventListener('click', (event) => {
    if (event.target === $('sourceOverlay')) closeSourcePicker();
  });

  // info
  $('infoBtn').addEventListener('click', openInfoModal);
  $('closeInfoBtn').addEventListener('click', closeInfoModal);
  $('openScreenSettingsBtn').addEventListener('click', () => window.loomBridge.openPermissionSettings('screen'));
  $('openCameraSettingsBtn').addEventListener('click', () => window.loomBridge.openPermissionSettings('camera'));
  $('openMicSettingsBtn').addEventListener('click', () => window.loomBridge.openPermissionSettings('microphone'));
  $('infoOverlay').addEventListener('click', (event) => {
    if (event.target === $('infoOverlay')) closeInfoModal();
  });

  $('closeBtn').addEventListener('click', () => window.loomBridge.quitApp());

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if ($('infoOverlay').classList.contains('open')) closeInfoModal();
    else if ($('sourceOverlay').classList.contains('open')) closeSourcePicker();
  });

  // main-process events
  state.disposers.push(window.loomBridge.onCursorPoint((point) => {
    state.cursor = point;
    if (!state.isRecording || !state.zoomEnabled || state.zoom.manual !== null) return;
    if (point.stillMs > 240 && point.travelled > 80) {
      state.zoom.autoUntil = Date.now() + AUTO_HOLD_MS;
    }
  }));

  state.disposers.push(window.loomBridge.onHotkey((action) => {
    if (action === 'zoom-in') zoomIn();
    else if (action === 'zoom-out') zoomOut();
    else if (action === 'toggle-pause') togglePauseResume();
    else if (action === 'stop') stopRecording();
  }));

  let refreshTimer = null;
  state.disposers.push(window.loomBridge.onRecordingsChanged(() => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadRecordings(), 400);
  }));

  window.addEventListener('resize', () => {
    keepElementInViewport($('recorderView'));
    keepElementInViewport($('cameraBubble'));
  });
}

function init() {
  showView('homeView');
  setUiState();
  switchPill(false);
  updateTimerDisplay();
  setStatus('Ready');

  initializeWidgetPositions();
  makeDraggable($('recorderView'), '.row, button, .rec-item, .rec-action, .home-list');
  makeDraggable($('cameraBubble'));
  bindOverlayInteractivity();
  bindRegionSelector();
  bindEvents();
  applyPanelScale(state.panelScale);

  loadRecordings();
  defaultToPrimaryScreen();
}

init();
