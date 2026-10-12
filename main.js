const { app, BrowserWindow, ipcMain, dialog, Menu, utilityProcess } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const pty = require('node-pty');
const os = require('os');

let mainWindow = null;


function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:openFolder'),
        },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow?.webContents.send('menu:openFile'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:saveAs'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('Ryekit');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

// ── Folder picker ───────────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Ryekit — Open Folder',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});


// ── Single-file picker (for the disassembler) ───────────
ipcMain.handle('dialog:openBinary', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Ryekit — Open Binary',
    properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

// ── Recursive directory read (bounded) ──────────────────
const IGNORED = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', '.next']);

async function readTree(dir, depth = 0) {
  if (depth > 6) return []; // safety stop
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  // folders first, then files, alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (IGNORED.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({
        name: entry.name,
        path: full,
        type: 'dir',
        children: await readTree(full, depth + 1),
      });
    } else if (entry.isFile()) {
      out.push({ name: entry.name, path: full, type: 'file' });
    }
  }
  return out;
}

ipcMain.handle('fs:readTree', async (_e, dir) => {
  return readTree(dir);
});

// ── Read / write a single file ──────────────────────────
ipcMain.handle('fs:readFile', async (_e, filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:writeFile', async (_e, filePath, content) => {
  try {
    await fs.writeFile(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Save As (for unsaved buffers) ───────────────────────
ipcMain.handle('dialog:saveAs', async (_e, content) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Ryekit — Save File',
    defaultPath: 'note.txt',
    filters: [{ name: 'Text', extensions: ['txt', 'md', 'js', 'json', 'html', 'css'] }],
  });
  if (canceled || !filePath) return null;
  try {
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  } catch (err) {
    return null;
  }
});


// ── Binary sniffing ─────────────────────────────────────
// Reads the first 8 KB and decides if the file looks binary.
// Rules (in order):
//   1. Contains a NUL byte → binary.
//   2. High ratio of non-printable ASCII → binary.
//   3. Otherwise → text.
ipcMain.handle('fs:isBinary', async (_e, filePath) => {
  try {
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const slice = buf.subarray(0, bytesRead);

      // 1. NUL byte → binary (classic C-string heuristic)
      if (slice.includes(0)) return { binary: true };

      // 2. Count control bytes (excluding \t \n \r \f \b)
      let ctrl = 0;
      for (let i = 0; i < slice.length; i++) {
        const b = slice[i];
        if (b < 0x09) ctrl++;
        else if (b > 0x0d && b < 0x20) ctrl++;
      }
      if (slice.length > 0 && ctrl / slice.length > 0.10) {
        return { binary: true };
      }

      // 3. Also flag ELF / Mach-O / PE magic explicitly, in case the
      //    header is pure ASCII (rare, but cheap to check).
      if (slice.length >= 4) {
        const magic = slice.subarray(0, 4).toString('hex');
        if (magic === '7f454c46' ||  // ELF
            magic.startsWith('cafebabe') || // Mach-O fat
            magic === 'feedface' || magic === 'feedfacf' ||
            magic === 'cefaedfe' || magic === 'cffaedfe' ||
            magic.startsWith('4d5a')) { // PE (MZ)
          return { binary: true };
        }
      }

      return { binary: false };
    } finally {
      await fh.close();
    }
  } catch (err) {
    // If we can't read it, treat as binary to be safe.
    return { binary: true, error: err.message };
  }
});



// ── Disassembler worker bridge ──────────────────────────
let disasmWorker = null;
let disasmWorkerReady = false;
const disasmJobs = new Map();

function ensureDisasmWorker() {
  if (disasmWorker) return disasmWorker;

  disasmWorker = utilityProcess.fork(
    path.join(__dirname, 'disasm-worker.js'),
    [],
    { serviceName: 'disasm-worker', stdio: 'pipe' }
  );
  disasmWorker.on('spawn', () => { disasmWorkerReady = true; });
  disasmWorker.on('message', (payload) => {
    const wcId = disasmJobs.get(payload.id);
    if (!wcId) return;
    const wc = require('electron').webContents.fromId(wcId);
    if (wc && !wc.isDestroyed()) wc.send('disasm:event', payload);
    if (payload.type === 'done' || payload.type === 'error') disasmJobs.delete(payload.id);
  });
  disasmWorker.on('exit', (code) => {
    disasmWorkerReady = false;
    disasmWorker = null;
    for (const [id, wcId] of disasmJobs) {
      const wc = require('electron').webContents.fromId(wcId);
      if (wc && !wc.isDestroyed()) {
        wc.send('disasm:event', { id, type: 'error', error: `worker exited (code ${code})` });
      }
    }
    disasmJobs.clear();
  });

  return disasmWorker;
}

ipcMain.handle('disasm:start', (event, payload) => {
  const wc = ensureDisasmWorker();
  const id = payload.id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  disasmJobs.set(id, event.sender.id);
  if (!disasmWorkerReady) wc.once('spawn', () => wc.postMessage({ ...payload, id }));
  else wc.postMessage({ ...payload, id });
  return id;
});

// ── Integrated bash terminal ────────────────────────────
// One PTY per renderer. Kept in a Map keyed by webContents.id.
const ptys = new Map();

function spawnPty(webContentsId) {
  if (ptys.has(webContentsId)) return ptys.get(webContentsId);

  const shell = process.env.SHELL || '/bin/bash';
  const cwd = os.homedir();

  const p = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  p.onData((data) => {
    const wc = require('electron').webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed()) wc.send('pty:data', data);
  });

  p.onExit(({ exitCode, signal }) => {
    const wc = require('electron').webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed()) wc.send('pty:exit', { exitCode, signal });
    ptys.delete(webContentsId);
  });

  ptys.set(webContentsId, p);
  return p;
}

ipcMain.handle('pty:start', (event) => {
  spawnPty(event.sender.id);
  return true;
});

ipcMain.on('pty:input', (event, data) => {
  const p = ptys.get(event.sender.id);
  if (p) p.write(data);
});

ipcMain.on('pty:resize', (event, { cols, rows }) => {
  const p = ptys.get(event.sender.id);
  if (p) {
    try { p.resize(cols, rows); } catch {}
  }
});

ipcMain.on('pty:kill', (event) => {
  const p = ptys.get(event.sender.id);
  if (p) { try { p.kill(); } catch {} ptys.delete(event.sender.id); }
});

// Clean up on window close
app.on('web-contents-created', (_e, wc) => {
  wc.on('destroyed', () => {
    const p = ptys.get(wc.id);
    if (p) { try { p.kill(); } catch {} ptys.delete(wc.id); }
  });
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
