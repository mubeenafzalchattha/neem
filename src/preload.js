const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loomBridge', {
  /* capture sources */
  getCaptureSources() {
    return ipcRenderer.invoke('get-capture-sources');
  },
  setPendingSource(sourceId) {
    return ipcRenderer.invoke('set-pending-source', sourceId);
  },
  getDisplays() {
    return ipcRenderer.invoke('get-displays');
  },

  /* permissions */
  checkPermissions() {
    return ipcRenderer.invoke('check-permissions');
  },
  requestMediaPermission(mediaType) {
    return ipcRenderer.invoke('request-media-permission', mediaType);
  },
  openPermissionSettings(mediaType) {
    return ipcRenderer.invoke('open-permission-settings', mediaType);
  },

  /* recordings library */
  saveRecording(payload) {
    return ipcRenderer.invoke('save-recording', payload);
  },
  listRecordings() {
    return ipcRenderer.invoke('list-recordings');
  },
  openRecording(filePath) {
    return ipcRenderer.invoke('open-recording', filePath);
  },
  revealRecording(filePath) {
    return ipcRenderer.invoke('reveal-recording', filePath);
  },
  deleteRecording(filePath) {
    return ipcRenderer.invoke('delete-recording', filePath);
  },
  openRecordingsFolder() {
    return ipcRenderer.invoke('open-recordings-folder');
  },

  /* cursor tracking */
  startCursorTracking(intervalMs) {
    return ipcRenderer.invoke('start-cursor-tracking', intervalMs);
  },
  stopCursorTracking() {
    return ipcRenderer.invoke('stop-cursor-tracking');
  },
  onCursorPoint(callback) {
    const handler = (_event, point) => callback(point);
    ipcRenderer.on('cursor-point', handler);
    return () => ipcRenderer.removeListener('cursor-point', handler);
  },

  /* global hotkeys */
  registerRecordingShortcuts() {
    return ipcRenderer.invoke('register-recording-shortcuts');
  },
  unregisterRecordingShortcuts() {
    return ipcRenderer.invoke('unregister-recording-shortcuts');
  },
  onHotkey(callback) {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('hotkey', handler);
    return () => ipcRenderer.removeListener('hotkey', handler);
  },

  /* misc */
  onRecordingsChanged(callback) {
    const handler = () => callback();
    ipcRenderer.on('recordings-changed', handler);
    return () => ipcRenderer.removeListener('recordings-changed', handler);
  },
  setContentProtection(enabled) {
    return ipcRenderer.invoke('set-content-protection', enabled);
  },
  setIgnoreMouseEvents(ignore) {
    return ipcRenderer.invoke('set-ignore-mouse-events', ignore);
  },
  quitApp() {
    return ipcRenderer.invoke('quit-app');
  }
});
