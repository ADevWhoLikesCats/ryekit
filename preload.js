const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // File system / dialog
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openBinary: () => ipcRenderer.invoke('dialog:openBinary'),
  readTree:   (dir) => ipcRenderer.invoke('fs:readTree', dir),
  readFile:   (p) => ipcRenderer.invoke('fs:readFile', p),
  isBinary:   (p) => ipcRenderer.invoke('fs:isBinary', p),
  readBytes:  (p, off, len) => ipcRenderer.invoke('fs:readBytes', p, off, len),
  writeFile:  (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  saveAs:     (c) => ipcRenderer.invoke('dialog:saveAs', c),

  // Application menu → renderer
  onMenuOpenFolder: (cb) => {
    const h = () => cb();
    ipcRenderer.on('menu:openFolder', h);
    return () => ipcRenderer.removeListener('menu:openFolder', h);
  },
  onMenuOpenFile: (cb) => {
    const h = () => cb();
    ipcRenderer.on('menu:openFile', h);
    return () => ipcRenderer.removeListener('menu:openFile', h);
  },
  onMenuSave: (cb) => {
    const h = () => cb();
    ipcRenderer.on('menu:save', h);
    return () => ipcRenderer.removeListener('menu:save', h);
  },
  onMenuSaveAs: (cb) => {
    const h = () => cb();
    ipcRenderer.on('menu:saveAs', h);
    return () => ipcRenderer.removeListener('menu:saveAs', h);
  },

  // Integrated terminal
  pty: {
    start:  () => ipcRenderer.invoke('pty:start'),
    input:  (data) => ipcRenderer.send('pty:input', data),
    resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
    kill:   () => ipcRenderer.send('pty:kill'),
    onData: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('pty:data', h);
      return () => ipcRenderer.removeListener('pty:data', h);
    },
    onExit: (cb) => {
      const h = (_e, info) => cb(info);
      ipcRenderer.on('pty:exit', h);
      return () => ipcRenderer.removeListener('pty:exit', h);
    },
  },

  // Disassembler
  disasm: {
    start: (payload) => ipcRenderer.invoke('disasm:start', payload),
    parse: (payload) => ipcRenderer.invoke('disasm:parse', payload),
    onEvent: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('disasm:event', h);
      return () => ipcRenderer.removeListener('disasm:event', h);
    },
  },
});
