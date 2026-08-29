const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  shell,
  systemPreferences,
  screen,
  globalShortcut
} = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

let mainWindow = null;
let cursorTimer = null;
let pendingSourceId = null;

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

function recordingsDir() {
  const base = app.getPath('videos') || path.join(os.homedir(), 'Movies');
  return path.join(base, 'Neem');
}

function metaDir() {
  return path.join(recordingsDir(), '.neem');
}

function thumbsDir() {
  return path.join(metaDir(), 'thumbs');
}

function indexFile() {
  return path.join(metaDir(), 'index.json');
}

function ensureDirs() {
  for (const dir of [recordingsDir(), metaDir(), thumbsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function readIndex() {
  try {
    if (!fs.existsSync(indexFile())) return {};
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8')) || {};
  } catch (_error) {
    return {};
  }
}

function writeIndex(data) {
  try {
    ensureDirs();
    fs.writeFileSync(indexFile(), JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write recording index:', error);
  }
}

/* ------------------------------------------------------------------ *
 * ffmpeg
 *
 * IMPORTANT: never chmod / write inside the .app bundle at runtime.
 * Mutating bundle contents invalidates the code signature and macOS then
 * refuses to launch the app with "the application is damaged".
 * If the bundled binary is not executable we copy it to userData instead.
 * ------------------------------------------------------------------ */

let cachedFfmpegPath = null;

function resolveFfmpegExecutablePath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  if (!ffmpegPath) {
    console.error('ffmpeg-static did not return a path.');
    return null;
  }

  let bundled = ffmpegPath;
  if (bundled.includes('app.asar')) {
    bundled = bundled.replace('app.asar', 'app.asar.unpacked');
  }

  if (!fs.existsSync(bundled)) {
    console.error('ffmpeg binary not found at:', bundled);
    return null;
  }

  // Happy path: already executable, use it in place and touch nothing.
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
    cachedFfmpegPath = bundled;
    return cachedFfmpegPath;
  } catch (_error) {
    // Not executable - fall through to the writable copy.
  }

  try {
    const localBin = path.join(app.getPath('userData'), 'bin');
    if (!fs.existsSync(localBin)) fs.mkdirSync(localBin, { recursive: true });
    const localFfmpeg = path.join(localBin, 'ffmpeg');

    let needsCopy = true;
    if (fs.existsSync(localFfmpeg)) {
      const a = fs.statSync(localFfmpeg);
      const b = fs.statSync(bundled);
      needsCopy = a.size !== b.size;
    }

    if (needsCopy) {
      fs.copyFileSync(bundled, localFfmpeg);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(localFfmpeg, 0o755);
    }

    cachedFfmpegPath = localFfmpeg;
    return cachedFfmpegPath;
  } catch (error) {
    console.error('Failed to prepare a writable ffmpeg copy:', error);
    return null;
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpegExecutablePath();
    if (!bin) {
      reject(new Error('ffmpeg binary is not available.'));
      return;
    }

    const proc = spawn(bin, args);
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1200)}`));
    });
    proc.on('error', reject);
  });
}

function convertWebmToMp4(inputPath, outputPath) {
  return runFfmpeg([
    '-y',
    '-i', inputPath,
    '-vf', 'fps=30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ]);
}

async function makeThumbnail(videoPath, thumbPath, seekSeconds = 1) {
  await runFfmpeg([
    '-y',
    '-ss', String(seekSeconds),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=480:-2',
    '-q:v', '4',
    thumbPath
  ]);
}

function thumbPathFor(fileName) {
  return path.join(thumbsDir(), `${fileName}.jpg`);
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const appIconPath = path.join(__dirname, 'logo.png');

  mainWindow = new BrowserWindow({
    x: primary.bounds.x,
    y: primary.bounds.y,
    width: primary.bounds.width,
    height: primary.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ *
 * Capture sources
 * ------------------------------------------------------------------ */

function serializeDisplay(display) {
  return {
    id: display.id,
    label: display.label,
    bounds: display.bounds,
    scaleFactor: display.scaleFactor
  };
}

ipcMain.handle('get-capture-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 250 },
    fetchWindowIcons: true
  });

  const displays = screen.getAllDisplays();

  const screens = [];
  const windows = [];

  for (const source of sources) {
    const item = {
      id: source.id,
      name: source.name,
      displayId: source.display_id || '',
      thumbnail: source.thumbnail && !source.thumbnail.isEmpty()
        ? source.thumbnail.toDataURL()
        : null,
      appIcon: source.appIcon && !source.appIcon.isEmpty()
        ? source.appIcon.toDataURL()
        : null
    };

    if (source.id.startsWith('screen:')) {
      const match = displays.find((d) => String(d.id) === String(source.display_id));
      item.display = match ? serializeDisplay(match) : null;
      screens.push(item);
    } else {
      windows.push(item);
    }
  }

  return {
    screens,
    windows,
    displays: displays.map(serializeDisplay),
    primaryDisplayId: String(screen.getPrimaryDisplay().id)
  };
});

ipcMain.handle('set-pending-source', (_event, sourceId) => {
  pendingSourceId = sourceId || null;
  return true;
});

ipcMain.handle('get-displays', () => ({
  displays: screen.getAllDisplays().map(serializeDisplay),
  primaryDisplayId: String(screen.getPrimaryDisplay().id)
}));

/* ------------------------------------------------------------------ *
 * Cursor tracking (drives the zoom that follows the pointer)
 * ------------------------------------------------------------------ */

ipcMain.handle('start-cursor-tracking', (_event, intervalMs = 16) => {
  if (cursorTimer) clearInterval(cursorTimer);

  let lastX = null;
  let lastY = null;
  let stillSince = Date.now();
  let movedSinceStill = 0;

  cursorTimer = setInterval(() => {
    const point = screen.getCursorScreenPoint();
    const now = Date.now();

    if (lastX !== null) {
      const dx = point.x - lastX;
      const dy = point.y - lastY;
      const dist = Math.hypot(dx, dy);
      if (dist > 2) {
        movedSinceStill += dist;
        stillSince = now;
      }
    }

    lastX = point.x;
    lastY = point.y;

    sendToRenderer('cursor-point', {
      x: point.x,
      y: point.y,
      stillMs: now - stillSince,
      travelled: movedSinceStill
    });

    if (now - stillSince > 1200) {
      movedSinceStill = 0;
    }
  }, Math.max(8, Number(intervalMs) || 16));

  return true;
});

ipcMain.handle('stop-cursor-tracking', () => {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  return true;
});

/* ------------------------------------------------------------------ *
 * Global shortcuts while recording
 * ------------------------------------------------------------------ */

const SHORTCUTS = {
  'CommandOrControl+Shift+Z': 'zoom-in',
  'CommandOrControl+Shift+X': 'zoom-out',
  'CommandOrControl+Shift+P': 'toggle-pause',
  'CommandOrControl+Shift+S': 'stop'
};

ipcMain.handle('register-recording-shortcuts', () => {
  const registered = [];
  for (const [accelerator, action] of Object.entries(SHORTCUTS)) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        sendToRenderer('hotkey', action);
      });
      if (ok) registered.push(accelerator);
    } catch (error) {
      console.error('Failed to register shortcut', accelerator, error);
    }
  }
  return registered;
});

ipcMain.handle('unregister-recording-shortcuts', () => {
  globalShortcut.unregisterAll();
  return true;
});

/* ------------------------------------------------------------------ *
 * Recording library
 * ------------------------------------------------------------------ */

function buildRecordingEntry(fileName, index) {
  const filePath = path.join(recordingsDir(), fileName);
  let stats = null;
  try {
    stats = fs.statSync(filePath);
  } catch (_error) {
    return null;
  }

  const meta = index[fileName] || {};
  const thumb = thumbPathFor(fileName);

  return {
    name: fileName,
    path: filePath,
    size: stats.size,
    createdAt: meta.createdAt || stats.birthtimeMs || stats.mtimeMs,
    durationMs: meta.durationMs || 0,
    mode: meta.mode || 'screen',
    thumbnail: fs.existsSync(thumb) ? `file://${encodeURI(thumb)}` : null
  };
}

ipcMain.handle('list-recordings', async () => {
  ensureDirs();
  const index = readIndex();

  let files = [];
  try {
    files = fs.readdirSync(recordingsDir())
      .filter((name) => /\.(mp4|webm|mov)$/i.test(name));
  } catch (_error) {
    files = [];
  }

  const entries = files
    .map((name) => buildRecordingEntry(name, index))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);

  // Backfill missing thumbnails in the background so the list appears fast.
  for (const entry of entries) {
    if (entry.thumbnail) continue;
    makeThumbnail(entry.path, thumbPathFor(entry.name))
      .then(() => sendToRenderer('recordings-changed'))
      .catch(() => {});
  }

  return { folder: recordingsDir(), recordings: entries };
});

ipcMain.handle('save-recording', async (_event, payload) => {
  const { buffer, durationMs = 0, mode = 'screen' } = payload || {};
  ensureDirs();

  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = `neem-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;

  const tempInputPath = path.join(os.tmpdir(), `${base}.webm`);
  fs.writeFileSync(tempInputPath, Buffer.from(buffer));

  const mp4Path = path.join(recordingsDir(), `${base}.mp4`);
  let finalPath = mp4Path;
  let format = 'mp4';
  let warning = null;

  try {
    await convertWebmToMp4(tempInputPath, mp4Path);
  } catch (error) {
    console.error('Conversion error:', error);
    finalPath = path.join(recordingsDir(), `${base}.webm`);
    format = 'webm';
    warning = `MP4 conversion failed, kept the WEBM original. ${error.message}`;
    fs.copyFileSync(tempInputPath, finalPath);
  } finally {
    if (fs.existsSync(tempInputPath)) {
      try { fs.unlinkSync(tempInputPath); } catch (_e) {}
    }
  }

  const fileName = path.basename(finalPath);
  const index = readIndex();
  index[fileName] = {
    createdAt: Date.now(),
    durationMs,
    mode
  };
  writeIndex(index);

  try {
    await makeThumbnail(finalPath, thumbPathFor(fileName), Math.min(1, durationMs / 2000));
  } catch (_error) {
    // A missing thumbnail is not fatal.
  }

  return {
    saved: true,
    format,
    warning,
    folder: recordingsDir(),
    recording: buildRecordingEntry(fileName, index)
  };
});

ipcMain.handle('delete-recording', async (_event, filePath) => {
  if (!filePath) return false;
  try {
    const fileName = path.basename(filePath);
    await shell.trashItem(filePath);
    const thumb = thumbPathFor(fileName);
    if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
    const index = readIndex();
    delete index[fileName];
    writeIndex(index);
    return true;
  } catch (error) {
    console.error('Failed to delete recording:', error);
    return false;
  }
});

ipcMain.handle('reveal-recording', (_event, filePath) => {
  if (!filePath) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('open-recordings-folder', () => {
  ensureDirs();
  shell.openPath(recordingsDir());
  return recordingsDir();
});

ipcMain.handle('open-recording', async (_event, filePath) => {
  if (!filePath) return false;
  await shell.openPath(filePath);
  return true;
});

/* ------------------------------------------------------------------ *
 * Permissions / window chrome
 * ------------------------------------------------------------------ */

ipcMain.handle('check-permissions', () => {
  if (process.platform !== 'darwin') {
    return { screen: 'granted', camera: 'granted', microphone: 'granted' };
  }

  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone')
  };
});

ipcMain.handle('request-media-permission', async (_event, mediaType) => {
  if (process.platform !== 'darwin') return true;
  if (mediaType !== 'camera' && mediaType !== 'microphone') return false;
  return systemPreferences.askForMediaAccess(mediaType);
});

ipcMain.handle('open-permission-settings', async (_event, mediaType) => {
  const urls = {
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  };
  return shell.openExternal(urls[mediaType] || urls.screen);
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

ipcMain.handle('set-content-protection', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  // Excludes the Neem overlay itself from screen capture so the control pill
  // and the raw camera bubble never get baked into the recording.
  win.setContentProtection(Boolean(enabled));
  return true;
});

ipcMain.handle('set-ignore-mouse-events', (event, ignore) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  return true;
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

app.whenReady().then(() => {
  ensureDirs();

  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = path.join(__dirname, 'logo.png');
    if (fs.existsSync(dockIconPath)) {
      try { app.dock.setIcon(dockIconPath); } catch (_e) {}
    }
  }

  // Modern Electron prefers getDisplayMedia over the legacy
  // chromeMediaSource constraints. Hand back whichever source the renderer
  // picked so both code paths capture the same thing.
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 }
        });
        const match = sources.find((s) => s.id === pendingSourceId) || sources[0];
        callback(match ? { video: match } : {});
      } catch (error) {
        console.error('Display media request failed:', error);
        callback({});
      }
    }, { useSystemPicker: false });
  } catch (error) {
    console.error('Could not install the display media handler:', error);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
