const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: patch => ipcRenderer.invoke('save-settings', patch),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  getVersions: () => ipcRenderer.invoke('get-versions'),
  getLoaderVersions: opts => ipcRenderer.invoke('get-loader-versions', opts),
  openInstanceDir: opts => ipcRenderer.invoke('open-instance-dir', opts),
  getJavas: () => ipcRenderer.invoke('get-javas'),
  modSearch: opts => ipcRenderer.invoke('mod-search', opts),
  modFiles: opts => ipcRenderer.invoke('mod-files', opts),
  modInstall: opts => ipcRenderer.invoke('mod-install', opts),
  aiAsk: opts => ipcRenderer.invoke('ai-ask', opts),
  netCheck: () => ipcRenderer.invoke('net-check'),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  onUpdateDownloaded: cb => ipcRenderer.on('update-downloaded', (_e, info) => cb(info)),
  launch: opts => ipcRenderer.invoke('launch', opts),
  onProgress: cb => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onGameLog: cb => ipcRenderer.on('game-log', (_e, line) => cb(line)),
  onGameExit: cb => ipcRenderer.on('game-exit', (_e, info) => cb(info)),
});
