const $ = (id) => document.getElementById(id);

const fileTree      = $('file-tree');
const folderName    = $('folder-name');
const statusMsg     = $('status-msg');
const statusLang    = $('status-lang');
const statusPos     = $('status-pos');
const openFolderBtn = $('open-folder-btn');

let monacoEditor = null;
let rootFolder = null;
let savedContent = '';

// ── Tab state ───────────────────────────────────────────
// path → { path, name, model, viewState, dirty, preview }
const openTabs = new Map();
let activeTabPath = null;

// Map a file path to a Monaco language id
function langFromPath(p) {
  if (!p) return 'plaintext';
  const ext = p.split('.').pop().toLowerCase();
  return {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    json: 'json', html: 'html', htm: 'html', css: 'css',
    scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown', txt: 'plaintext',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', php: 'php',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    xml: 'xml', svg: 'xml',
    sql: 'sql', graphql: 'graphql',
    dockerfile: 'dockerfile',
    lua: 'lua', pl: 'perl', r: 'r',
  }[ext] || 'plaintext';
}


// Wait until monacoEditor is ready; safe to call anytime.
function waitForMonaco(timeoutMs = 5000) {
  if (monacoEditor) return Promise.resolve(monacoEditor);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (monacoEditor) return resolve(monacoEditor);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Monaco never initialized'));
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}


function hasDirtyTabs() {
  for (const t of openTabs.values()) if (t.dirty) return true;
  return false;
}

function dirtyTabNames() {
  const names = [];
  for (const [p, t] of openTabs) if (t.dirty) names.push(t.path.split('/').pop());
  return names;
}


function setStatus(text, kind = '') {
  statusMsg.textContent = text;
  statusMsg.className = 'msg ' + kind;
}
function setDirty(d) {
  // Per-tab dots handle this now; keep the helper for API compatibility.
  if (!activeTabPath) return;
  const tab = openTabs.get(activeTabPath);
  if (tab) {
    tab.dirty = d;
    updateTabDirty(activeTabPath, d);
  }
}


// Extensions we treat as binary (skip in the tree)
const BINARY_EXTS = new Set([
  // images
  'png','jpg','jpeg','gif','bmp','webp','ico','tif','tiff','svgz','avif','heic',
  // audio
  'mp3','wav','ogg','oga','flac','aac','m4a','opus','wma',
  // video
  'mp4','mkv','mov','avi','webm','wmv','flv','m4v','mpg','mpeg',
  // archives
  'zip','tar','gz','bz2','xz','7z','rar','tgz','lz','lzma','zst','cab','iso',
  // documents
  'pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','epub',
  // executables / objects
  'exe','dll','so','dylib','bin','o','a','obj','lib','class','jar','war','apk','appimage','deb','rpm','msi',
  // fonts
  'ttf','otf','woff','woff2','eot',
  // misc data
  'db','sqlite','sqlite3','mdb','dat','bin','pak','wasm','pyc','pyo','node',
]);


function markBinary(el, node) {
  el.classList.add('binary');
  el.title = `${node.path}\n(binary file — not editable)`;
}

function isBinary(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXTS.has(name.slice(dot + 1).toLowerCase());
}


// ── Bottom Panel framework (VS Code style) ──────────────
// New tool panes register via:  Panel.registerTab({ id, label, icon, mount })
// `mount(container)` is called once, the first time the tab is shown.
// `onResize(cols, rows)` is optional (useful for xterm-like tools).
const Panel = (() => {
  const panel      = document.getElementById('panel');
  const resizer    = document.getElementById('panel-resizer');
  const tabStrip   = document.getElementById('panel-tab-strip');
  const body       = document.getElementById('panel-body');
  const btnMax     = document.getElementById('panel-maximize');
  const btnClose   = document.getElementById('panel-close');

  const tabs = new Map();   // id -> { id, label, icon, el, viewEl, mount, mounted, onResize, badge }
  let activeId = null;
  let maximized = false;

  const DEFAULT_HEIGHT = 260;
  let lastHeight = DEFAULT_HEIGHT;

  function makeTabEl(tab) {
    const el = document.createElement('div');
    el.className = 'panel-tab';
    el.dataset.tab = tab.id;
    el.innerHTML = `
      ${tab.icon ? `<span class="icon">${tab.icon}</span>` : ''}
      <span class="label">${tab.label}</span>
      ${tab.badge != null ? `<span class="badge">${tab.badge}</span>` : ''}
    `;
    el.addEventListener('click', () => activate(tab.id));
    return el;
  }

  function activate(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    activeId = id;

    // Lazy mount
    if (!tab.mounted && tab.mount) {
      tab.mounted = true;
      try { tab.mount(tab.viewEl); }
      catch (err) { console.error(`[panel] mount "${id}" failed:`, err); }
    }

    // Update UI
    for (const [tid, t] of tabs) {
      const isActive = tid === id;
      t.el.classList.toggle('active', isActive);
      t.viewEl.hidden = !isActive;
    }

    // Let the tab react to becoming visible (needed for xterm.fit())
    requestAnimationFrame(() => {
      try { tab.onResize && tab.onResize(); } catch {}
    });
  }

  function open() {
    panel.classList.remove('collapsed');
    resizer.style.display = '';
    if (activeId) requestAnimationFrame(() => {
      const t = tabs.get(activeId);
      try { t && t.onResize && t.onResize(); } catch {}
    });
  }

  function close() {
    panel.classList.add('collapsed');
  }

  function toggle() {
    if (panel.classList.contains('collapsed')) open();
    else close();
  }

  function maximize(force) {
    maximized = force === undefined ? !maximized : force;
    panel.classList.toggle('maximized', maximized);
    btnMax.textContent = maximized ? '⤡' : '⤢';
    btnMax.title = maximized ? 'Restore panel' : 'Maximize panel';
    requestAnimationFrame(() => {
      const t = tabs.get(activeId);
      try { t && t.onResize && t.onResize(); } catch {}
    });
  }

  btnClose.addEventListener('click', close);
  btnMax.addEventListener('click', () => maximize());

  // Drag-to-resize
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const paneRect = panel.parentElement.getBoundingClientRect();
    const newHeight = Math.max(60, Math.min(paneRect.height - 100, paneRect.bottom - e.clientY));
    panel.style.height = newHeight + 'px';
    panel.classList.remove('collapsed');
    const t = tabs.get(activeId);
    try { t && t.onResize && t.onResize(); } catch {}
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    lastHeight = parseInt(getComputedStyle(panel).height, 10) || DEFAULT_HEIGHT;
  });

  // Global toggle: Ctrl+`
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      toggle();
      if (!panel.classList.contains('collapsed')) {
        const t = tabs.get(activeId);
        t && t.focus && t.focus();
      }
    }
  });

  function registerTab({ id, label, icon, mount, onResize, badge, focus }) {
    if (tabs.has(id)) return tabs.get(id);

    const viewEl = document.createElement('div');
    viewEl.className = 'panel-view';
    viewEl.dataset.view = id;
    viewEl.hidden = true;
    body.appendChild(viewEl);

    const tab = { id, label, icon, mount, onResize, focus, el: null, viewEl, mounted: false, badge };
    tab.el = makeTabEl(tab);
    tabStrip.appendChild(tab.el);
    tabs.set(id, tab);

    // First registered tab becomes active
    if (!activeId) activate(id);
    return tab;
  }

  function setBadge(id, value) {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.badge = value;
    const b = tab.el.querySelector('.badge');
    if (b) b.textContent = value;
    else if (value != null) {
      const s = document.createElement('span');
      s.className = 'badge';
      s.textContent = value;
      tab.el.appendChild(s);
    }
  }

  function getActiveId() { return activeId; }
  function isOpen() { return !panel.classList.contains('collapsed'); }

  return { registerTab, activate, open, close, toggle, maximize, setBadge, getActiveId, isOpen, tabs };
})();

// Monaco init

// Monaco web worker loader — required for file:// origins
self.MonacoEnvironment = {
  getWorkerUrl: function () {
    const base = new URL('node_modules/monaco-editor/min/vs', document.baseURI).href;
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
      self.MonacoEnvironment = { baseUrl: '${base}/' };
      importScripts('${base}/base/worker/workerMain.js');
    `)}`;
  },
};

amdRequire.config({ baseUrl: new URL('node_modules/monaco-editor/min', document.baseURI).href });
console.log('[monaco] baseUrl =', new URL('node_modules/monaco-editor/min', document.baseURI).href);

amdRequire(['vs/editor/editor.main'], function () {
  monacoEditor = monaco.editor.create($('editor-container'), {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    fontFamily: "'Cascadia Code', ui-monospace, monospace",
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '400',
    fontLigatures: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    renderWhitespace: 'selection',
    padding: { top: 12, bottom: 12 },
    disableMonospaceOptimizations: false,
  });

  // (dirty tracking is per-tab now — see openTabs)

  monacoEditor.onDidChangeCursorPosition((e) => {
    statusPos.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      monaco.editor.remeasureFonts();
    });
  }

  setStatus('Ready');
});

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🟦', jsx: '⚛️', tsx: '⚛️',
    json: '🟫', html: '🟧', htm: '🟧', css: '🎨', scss: '🎨',
    md: '📘', txt: '📄', py: '🐍', sh: '📜', yml: '⚙️', yaml: '⚙️',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    lock: '🔒', env: '🔑',
  };
  return map[ext] || '📄';
}

function renderTree(nodes, container, depth = 0) {
  for (const node of nodes) {
    const el = document.createElement('div');
    el.className = 'tree-item';
    el.style.paddingLeft = `${10 + depth * 14}px`;
    el.title = node.path;

    if (node.type === 'dir') {
      el.innerHTML = `<span class="icon">📁</span><span class="label">${node.name}</span>`;
      container.appendChild(el);

      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'tree-children';
      container.appendChild(childrenWrap);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const hidden = childrenWrap.style.display === 'none';
        childrenWrap.style.display = hidden ? '' : 'none';
        el.querySelector('.icon').textContent = hidden ? '📂' : '📁';
      });

      renderTree(node.children, childrenWrap, depth + 1);
    } else {
      el.innerHTML = `<span class="icon">${fileIcon(node.name)}</span><span class="label">${node.name}</span>`;

      const knownBinary = isBinary(node.name);
      if (knownBinary) markBinary(el, node);

      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (el.classList.contains('binary')) {
          setStatus(`Skipped binary file: ${node.name}`, 'error');
          return;
        }
        // Unknown extension → sniff contents before opening
        if (!knownBinary) {
          try {
            const probe = await window.api.isBinary(node.path);
            if (probe.binary) {
              markBinary(el, node);
              setStatus(`Skipped binary file: ${node.name}`, 'error');
              return;
            }
          } catch {
            markBinary(el, node);
            setStatus(`Failed to inspect: ${node.name}`, 'error');
            return;
          }
        }
        openFile(node.path, el);
      });

      container.appendChild(el);
    }
  }
}

async function loadFolder(folderPath) {
  rootFolder = folderPath;
  folderName.textContent = folderPath.split('/').pop() || folderPath;
  fileTree.innerHTML = '<div class="tree-empty">Loading…</div>';

  const tree = await window.api.readTree(folderPath);
  fileTree.innerHTML = '';

  if (!tree.length) {
    fileTree.innerHTML = '<div class="tree-empty">(empty folder)</div>';
    return;
  }
  renderTree(tree, fileTree);
  setStatus(`Opened folder: ${folderPath}`, 'success');
}








openFolderBtn.addEventListener('click', async () => {
  if (hasDirtyTabs() && !confirm('You have unsaved changes. Discard them?')) return;
  const folder = await window.api.openFolder();
  if (folder) await loadFolder(folder);
});


window.addEventListener('beforeunload', (e) => {
  if (hasDirtyTabs()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Application menu events ────────────────────────────
window.api.onMenuOpenFolder(async () => {
  if (hasDirtyTabs() && !confirm('You have unsaved changes. Discard them?')) return;
  const folder = await window.api.openFolder();
  if (folder) await loadFolder(folder);
});

window.api.onMenuOpenFile(async () => {
  // Uses the existing folder dialog; if you add a file dialog later, swap here.
  if (hasDirtyTabs() && !confirm('You have unsaved changes. Discard them?')) return;
  const folder = await window.api.openFolder();
  if (folder) await loadFolder(folder);
});

window.api.onMenuSave(async () => {
  if (!monacoEditor) return;
  await saveCurrent();
});

window.api.onMenuSaveAs(async () => {
  if (!monacoEditor) return;
  await saveAsCurrent();
});



// ── Terminal tab (registered via Panel) ────────────────
(function registerTerminalTab() {
  if (!window.Terminal) {
    console.error('[terminal] xterm not loaded');
    return;
  }
  const TerminalCtor = window.Terminal;
  const FitCtor =
    (window.FitAddon && window.FitAddon.FitAddon) || window.fit?.FitAddon;

  let term = null;
  let fit = null;

  Panel.registerTab({
    id: 'terminal',
    label: 'Terminal',
    icon: '▸',
    mount(container) {
      term = new TerminalCtor({
        fontFamily: "'Cascadia Code', ui-monospace, monospace",
        fontSize: 12,
        lineHeight: 1.2,
        theme: {
          background: '#0a0d12', foreground: '#e6edf3', cursor: '#58a6ff',
          cursorAccent: '#0a0d12', selectionBackground: '#388bfd44',
          black: '#0d1117',  red: '#ff7b72',
          green: '#3fb950',  yellow: '#d29922',
          blue: '#58a6ff',   magenta: '#bc8cff',
          cyan: '#39c5cf',   white: '#b1bac4',
          brightBlack: '#6e7681', brightRed: '#ffa198',
          brightGreen: '#56d364', brightYellow: '#e3b341',
          brightBlue: '#79c0ff',  brightMagenta: '#d2a8ff',
          brightCyan: '#56d4dd',  brightWhite: '#f0f6fc',
        },
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
      });

      if (FitCtor) {
        fit = new FitCtor();
        term.loadAddon(fit);
      }

      term.open(container);
      try { fit && fit.fit(); } catch {}

      window.api.pty.start();
      term.onData((data) => window.api.pty.input(data));
      window.api.pty.onData((data) => term.write(data));
      window.api.pty.onExit(({ exitCode }) => {
        term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      });

      // Resize observer
      const ro = new ResizeObserver(() => {
        try {
          fit && fit.fit();
          window.api.pty.resize(term.cols, term.rows);
        } catch {}
      });
      ro.observe(container);

      container.addEventListener('mousedown', () => term.focus());
    },
    onResize() {
      try {
        fit && fit.fit();
        window.api.pty.resize(term.cols, term.rows);
      } catch {}
    },
    focus() { term && term.focus(); },
  });

  // Make Ctrl+` open the panel with Terminal active
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`' && Panel.isOpen()) {
      Panel.activate('terminal');
      setTimeout(() => term && term.focus(), 30);
    }
  });

  window.__term = () => term;
})();

// ── Placeholder tool tabs — replace with real implementations later ─







// ── Disassembly syntax highlighting ─────────────────────
// Instruction categories → CSS class
const MNEMONIC_GROUPS = [
  // control flow
  { re: /^(call|jmp|je|jne|jz|jnz|jg|jge|jl|jle|ja|jae|jb|jbe|js|jns|jo|jno|jp|jnp|jcxz|jecxz|jrcxz|loop|loopz|loopnz|loope|loopne|ret|retn|retf|iret|iretd|syscall|sysenter|int|int3|into|ud2)$/i, cls: 'mn-flow' },
  // stack ops
  { re: /^(push|pop|pusha|popa|pushad|popad|pushf|popf|pushfd|popfd|pushfq|popfq|enter|leave)$/i, cls: 'mn-stack' },
  // arithmetic / logic
  { re: /^(add|sub|adc|sbb|mul|imul|div|idiv|inc|dec|neg|cmp|test|and|or|xor|not|shl|shr|sal|sar|rol|ror|rcl|rcr|bt|bts|btr|btc|bsf|bsr)$/i, cls: 'mn-arith' },
  // data movement
  { re: /^(mov|movsx|movsxd|movzx|lea|xchg|cmov[a-z]+|cbw|cwde|cdqe|cwd|cdq|cqo|bswap|movs[bwdq]|stos[bwdq]|lods[bwdq]|scas[bwdq]|cmps[bwdq]|rep|repe|repne|repz|repnz)$/i, cls: 'mn-mov' },
  // floating / vector
  { re: /^(f[a-z0-9]+|v?mov[a-z0-9]*|v?add[a-z0-9]*|v?sub[a-z0-9]*|v?mul[a-z0-9]*|v?div[a-z0-9]*|v?p[a-z0-9]+|padd[a-z]*|psub[a-z]*|pmul[a-z]*|pxor|por|pand|pandn|aes[a-z]+|sha[a-z]+)$/i, cls: 'mn-vec' },
  // privileged / misc
  { re: /^(nop|hlt|pause|cpuid|rdtsc|rdmsr|wrmsr|in|out|in[bwl]|out[bwl]|cli|sti|clc|stc|cmc|lahf|sahf|aaa|aas|aam|aad|daa|das)$/i, cls: 'mn-misc' },
];

const REGISTER_RE = /^(r(1[0-5]|[0-9])[dwb]?|e(ax|bx|cx|dx|si|di|sp|bp|ip)|(a|b|c|d)[lhx]|[sd]il?|[sb]pl?|rip|eip|ip|rflags?|eflags?|flags?|cs|ds|es|fs|gs|ss|xmm\d{1,2}|ymm\d{1,2}|zmm\d{1,2}|mm\d|st\(?\d?\)?|cr\d|dr\d|k\d)$/i;

// Split an operand string into tokens we can color.
// Handles: registers, hex numbers, decimal numbers, immediates ($0x..),
// memory [] brackets, ptr keywords, size hints, quoted strings.
function tokenizeOperands(opStr) {
  if (!opStr) return '';
  const tokens = [];
  let s = opStr;

  // Escaped HTML first
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Split by commas but keep them
  const parts = s.split(/(\s*,\s*)/);
  for (const part of parts) {
    if (/^\s*,\s*$/.test(part)) { tokens.push(part); continue; }

    // Memory operand: [ ... ]
    if (part.includes('[')) {
      const inner = part.replace(/^([a-z]*\s+)?/, ''); // strip size prefix
      const prefixMatch = part.match(/^([a-z]+)\s+/i);
      let out = '';
      if (prefixMatch) {
        out += `<span class="tk-size">${prefixMatch[1]}</span> `;
      }
      out += inner.replace(/\[([^\]]*)\]/, (_m, body) => {
        const colored = body
          .replace(/([a-z][a-z0-9]*)/gi, (reg) =>
            REGISTER_RE.test(reg) ? `<span class="tk-reg">${reg}</span>` : reg
          )
          .replace(/\b(0x[0-9a-f]+|\d+)\b/gi, '<span class="tk-num">$1</span>')
          .replace(/\b(rip|eip|ip)\b/gi, '<span class="tk-rip">$1</span>');
        return `<span class="tk-mem">[</span>${colored}<span class="tk-mem">]</span>`;
      });
      tokens.push(out);
      continue;
    }

    // Register
    if (REGISTER_RE.test(part)) {
      tokens.push(`<span class="tk-reg">${part}</span>`);
      continue;
    }

    // Immediate / number
    if (/^(\$|-)?0x[0-9a-f]+$/i.test(part)) {
      tokens.push(`<span class="tk-hex">${part}</span>`);
      continue;
    }
    if (/^(\$|-)?\d+$/.test(part)) {
      tokens.push(`<span class="tk-num">${part}</span>`);
      continue;
    }

    // Quoted string
    if (/^".*"$/.test(part) || /^'.*'$/.test(part)) {
      tokens.push(`<span class="tk-str">${part}</span>`);
      continue;
    }

    // Label / symbol reference (bare identifier)
    if (/^[a-z_][a-z0-9_@.]*$/i.test(part)) {
      tokens.push(`<span class="tk-sym">${part}</span>`);
      continue;
    }

    tokens.push(part);
  }
  return tokens.join('');
}

function mnemonicClass(mn) {
  for (const g of MNEMONIC_GROUPS) {
    if (g.re.test(mn)) return g.cls;
  }
  return 'mn-other';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


// ── Tab system ──────────────────────────────────────────

function tabName(path) {
  return path.split('/').pop() || path;
}

function renderTabs() {
  if (!tabStrip) return;
  tabStrip.replaceChildren();

  for (const [path, tab] of openTabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (path === activeTabPath ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    el.title = path;
    el.dataset.path = path;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tabName(path);
    el.appendChild(label);

    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    el.appendChild(dot);

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close (Ctrl+W)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(path);
    });
    el.appendChild(close);

    el.addEventListener('click', () => switchTab(path));
    el.addEventListener('mousedown', (e) => {
      // middle-click closes
      if (e.button === 1) {
        e.preventDefault();
        closeTab(path);
      }
    });

    tabStrip.appendChild(el);
  }
}

function updateTabDirty(path, dirty) {
  const tab = openTabs.get(path);
  if (!tab) return;
  tab.dirty = dirty;
  renderTabs();
}

function switchTab(path) {
  const tab = openTabs.get(path);
  if (!tab || !monacoEditor) return;

  // Save current view state before switching
  if (activeTabPath && openTabs.has(activeTabPath)) {
    const cur = openTabs.get(activeTabPath);
    cur.viewState = monacoEditor.saveViewState();
  }

  activeTabPath = path;
  savedContent = tab.model.getValue();

  monacoEditor.setModel(tab.model);
  monaco.editor.setModelLanguage(tab.model, langFromPath(path));
  if (tab.viewState) monacoEditor.restoreViewState(tab.viewState);
  monacoEditor.focus();

  setDirty(tab.dirty);
  statusLang.textContent = langFromPath(path);
  setStatus(path);
  renderTabs();

  // Highlight in the tree
  document.querySelectorAll('.tree-item.active').forEach(n => n.classList.remove('active'));
  const treeEl = document.querySelector(`.tree-item[title="${CSS.escape(path)}"]`);
  if (treeEl) treeEl.classList.add('active');
}

function closeTab(path) {
  const tab = openTabs.get(path);
  if (!tab) return;

  if (tab.dirty) {
    const ok = confirm(`"${tabName(path)}" has unsaved changes. Close anyway?`);
    if (!ok) return;
  }

  const paths = [...openTabs.keys()];
  const idx = paths.indexOf(path);
  openTabs.delete(path);

  // Free Monaco's model to release memory
  try { tab.model.dispose(); } catch {}

  if (activeTabPath === path) {
    const next = paths[idx + 1] || paths[idx - 1];
    if (next && openTabs.has(next)) {
      activeTabPath = null;
      switchTab(next);
    } else {
      // No tabs left — clear the editor
      activeTabPath = null;
      savedContent = '';
      if (monacoEditor) {
        monacoEditor.setModel(monaco.editor.createModel('', 'plaintext'));
      }
      statusLang.textContent = 'Plain Text';
      setStatus('Ready');
      setDirty(false);
    }
  }
  renderTabs();
}

function closeAllTabs() {
  const dirty = [...openTabs.values()].filter(t => t.dirty);
  if (dirty.length && !confirm(`${dirty.length} file(s) have unsaved changes. Close all anyway?`)) return;
  for (const p of [...openTabs.keys()]) {
    const t = openTabs.get(p);
    try { t.model.dispose(); } catch {}
    openTabs.delete(p);
  }
  activeTabPath = null;
  savedContent = '';
  if (monacoEditor) monacoEditor.setModel(monaco.editor.createModel('', 'plaintext'));
  setDirty(false);
  setStatus('Ready');
  renderTabs();
}

async function openFile(filePath, treeEl) {
  // Already open → just focus the tab
  if (openTabs.has(filePath)) {
    switchTab(filePath);
    return;
  }

  await waitForMonaco();

  const result = await window.api.readFile(filePath);
  if (!result.ok) {
    setStatus(`Failed to read: ${result.error}`, 'error');
    return;
  }

  const language = langFromPath(filePath);
  const model = monaco.editor.createModel(result.content, language);

  const tab = {
    path: filePath,
    model,
    viewState: null,
    dirty: false,
  };
  openTabs.set(filePath, tab);

  model.onDidChangeContent(() => {
    const tab = openTabs.get(filePath);
    if (!tab) return;
    const dirty = model.getValue() !== savedContent || !tab.dirty ? (model.getValue() !== savedContent) : tab.dirty;
    // simpler: dirty if content differs from the initial saved snapshot
    const isDirty = model.getValue() !== (tab.savedContent ?? savedContent);
    tab.dirty = model.getValue() !== tab.initialContent;
    if (filePath === activeTabPath) setDirty(tab.dirty);
    updateTabDirty(filePath, tab.dirty);
  });

  tab.initialContent = result.content;
  tab.savedContent = result.content;

  switchTab(filePath);

  if (treeEl) {
    document.querySelectorAll('.tree-item.active').forEach(n => n.classList.remove('active'));
    treeEl.classList.add('active');
  }
}

async function saveCurrent() {
  if (!activeTabPath || !monacoEditor) return;
  const tab = openTabs.get(activeTabPath);
  if (!tab) return;

  const content = monacoEditor.getValue();
  const result = await window.api.writeFile(activeTabPath, content);
  if (!result.ok) {
    setStatus(`Save failed: ${result.error}`, 'error');
    return;
  }
  tab.initialContent = content;
  tab.dirty = false;
  updateTabDirty(activeTabPath, false);
  setDirty(false);
  setStatus(`Saved: ${activeTabPath}`, 'success');

  if (rootFolder && activeTabPath.startsWith(rootFolder)) {
    await loadFolder(rootFolder);
  }
}

async function saveAsCurrent() {
  if (!monacoEditor) return;
  const content = monacoEditor.getValue();
  const filePath = await window.api.saveAs(content);
  if (!filePath) { setStatus('Save As cancelled.'); return; }

  const oldPath = activeTabPath;
  if (oldPath && openTabs.has(oldPath)) {
    const old = openTabs.get(oldPath);
    try { old.model.dispose(); } catch {}
    openTabs.delete(oldPath);
  }

  const language = langFromPath(filePath);
  const model = monaco.editor.createModel(content, language);
  openTabs.set(filePath, {
    path: filePath,
    model,
    viewState: null,
    dirty: false,
    initialContent: content,
    savedContent: content,
  });
  activeTabPath = null;
  switchTab(filePath);
  setStatus(`Saved as: ${filePath}`, 'success');

  if (rootFolder && filePath.startsWith(rootFolder)) {
    await loadFolder(rootFolder);
  }
}

// Wire the close-all button and shortcuts
document.getElementById('tab-close-all')?.addEventListener('click', closeAllTabs);

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  if (e.key === 'w') {
    e.preventDefault();
    if (activeTabPath) closeTab(activeTabPath);
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const paths = [...openTabs.keys()];
    if (paths.length < 2) return;
    const idx = paths.indexOf(activeTabPath);
    const next = e.shiftKey
      ? paths[(idx - 1 + paths.length) % paths.length]
      : paths[(idx + 1) % paths.length];
    switchTab(next);
  }
});

// ── Hex viewer tab ──────────────────────────────────────
(function registerHexTab() {
  const WINDOW_SIZE = 64 * 1024;      // 64 KB chunk
  const BYTES_PER_ROW = 16;
  const ROW_HEIGHT = 18;
  const RENDER_MARGIN = 8;

  let container = null;
  let viewport = null;
  let spacer = null;
  let rowsLayer = null;

  let filePath = null;
  let fileSize = 0;
  let windowOffset = 0;               // where our 64 KB window starts
  let windowBytes = new Uint8Array(0);
  let loading = false;

  function buildShell() {
    container.innerHTML = `
      <div class="hex-toolbar">
        <button id="hex-pick">Open Binary…</button>
        <span class="hex-file" id="hex-file">no file</span>
        <span class="hex-status" id="hex-status"></span>
      </div>
      <div class="hex-viewport" id="hex-viewport">
        <div class="hex-spacer" id="hex-spacer"></div>
        <div class="hex-rows" id="hex-rows"></div>
      </div>
    `;
    viewport = container.querySelector('#hex-viewport');
    spacer = container.querySelector('#hex-spacer');
    rowsLayer = container.querySelector('#hex-rows');

    viewport.addEventListener('scroll', onScroll, { passive: true });
    new ResizeObserver(() => render()).observe(viewport);

    container.querySelector('#hex-pick').addEventListener('click', async () => {
      const p = await window.api.openBinary();
      if (p) openHex(p);
    });
    container.querySelector('#hex-pick').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const manual = prompt('Binary path:');
      if (manual) openHex(manual);
    });
  }

  function setStatus(text, kind = '') {
    const el = container.querySelector('#hex-status');
    if (el) { el.textContent = text; el.className = 'hex-status ' + kind; }
  }

  async function openHex(path) {
    filePath = path;
    container.querySelector('#hex-file').textContent = path;
    windowOffset = 0;
    windowBytes = new Uint8Array(0);
    setStatus('loading…');
    await loadWindow(0);
  }

  async function loadWindow(offset) {
    if (loading || !filePath) return;
    loading = true;
    setStatus('loading…');
    try {
      const res = await window.api.readBytes(filePath, offset, WINDOW_SIZE);
      if (!res.ok) { setStatus(`error: ${res.error}`, 'error'); loading = false; return; }
      windowOffset = res.offset;
      windowBytes = res.bytes;
      fileSize = res.size;
      spacer.style.height = `${Math.ceil(fileSize / BYTES_PER_ROW) * ROW_HEIGHT}px`;
      setStatus(`${res.size.toLocaleString()} bytes · window @ 0x${offset.toString(16)}`, 'success');
      render();
    } catch (err) {
      setStatus(`error: ${err.message}`, 'error');
    }
    loading = false;
  }

  function onScroll() {
    if (!viewport || !filePath) return;
    const scrollTop = viewport.scrollTop;
    const visibleOffset = Math.floor(scrollTop / ROW_HEIGHT) * BYTES_PER_ROW;
    const windowEnd = windowOffset + windowBytes.length;

    // Near the edge of our loaded window? load the next one.
    if (visibleOffset < windowOffset || visibleOffset + WINDOW_SIZE > windowEnd) {
      const newOffset = Math.max(0, Math.floor(visibleOffset / WINDOW_SIZE) * WINDOW_SIZE);
      if (newOffset !== windowOffset) loadWindow(newOffset);
    }
    render();
  }

  function makeRow(offset) {
    const row = document.createElement('div');
    row.className = 'hex-row';
    row.dataset.offset = offset;

    // Address column
    const addr = document.createElement('span');
    addr.className = 'hx-addr';
    addr.textContent = offset.toString(16).padStart(8, '0');
    row.appendChild(addr);

    // Hex column
    const hex = document.createElement('span');
    hex.className = 'hx-hex';
    const start = offset - windowOffset;
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      const b = windowBytes[start + i];
      const cell = document.createElement('span');
      cell.className = 'hx-cell';
      if (b === undefined) {
        cell.classList.add('hx-pad');
        cell.textContent = '  ';
      } else {
        cell.textContent = b.toString(16).padStart(2, '0');
        if (b >= 0x20 && b <= 0x7e) cell.classList.add('hx-printable');
      }
      hex.appendChild(cell);
      if (i === 7) {
        const gap = document.createElement('span');
        gap.className = 'hx-gap';
        gap.textContent = ' ';
        hex.appendChild(gap);
      }
    }
    row.appendChild(hex);

    // ASCII column
    const ascii = document.createElement('span');
    ascii.className = 'hx-ascii';
    let s = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      const b = windowBytes[start + i];
      s += (b === undefined) ? ' ' : (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.');
    }
    ascii.textContent = s;
    row.appendChild(ascii);

    return row;
  }

  function render() {
    if (!viewport || !rowsLayer || !fileSize) return;
    const scrollTop = viewport.scrollTop;
    const viewH = viewport.clientHeight;
    const totalRows = Math.ceil(fileSize / BYTES_PER_ROW);
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - RENDER_MARGIN);
    const last = Math.min(totalRows - 1, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + RENDER_MARGIN);

    rowsLayer.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    const frag = document.createDocumentFragment();
    for (let r = first; r <= last; r++) {
      const offset = r * BYTES_PER_ROW;
      // Skip rows outside our current window — they'll render once the
      // window loads (onScroll triggers it).
      if (offset < windowOffset || offset >= windowOffset + windowBytes.length) continue;
      frag.appendChild(makeRow(offset));
    }
    rowsLayer.replaceChildren(frag);
  }

  Panel.registerTab({
    id: 'hex',
    label: 'Hex',
    icon: '#',
    mount(node) {
      container = node;
      buildShell();
    },
  });
})();

// ── Section browser tab ─────────────────────────────────
(function registerSectionsTab() {
  let container = null;
  let filePath = null;
  let currentJobId = null;
  let unsubscribe = null;

  function buildShell() {
    container.innerHTML = `
      <div class="sections-toolbar">
        <button id="sections-pick">Open Binary…</button>
        <span class="sections-file" id="sections-file">no file</span>
        <span class="sections-status" id="sections-status"></span>
      </div>
      <div class="sections-body" id="sections-body">
        <div class="sections-placeholder">Pick a binary to see its sections.</div>
      </div>
    `;

    container.querySelector('#sections-pick').addEventListener('click', async () => {
      const p = await window.api.openBinary();
      if (p) parseBinary(p);
    });
    container.querySelector('#sections-pick').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const manual = prompt('Binary path:');
      if (manual) parseBinary(manual);
    });
  }

  function setStatus(text, kind = '') {
    const el = container.querySelector('#sections-status');
    if (el) { el.textContent = text; el.className = 'sections-status ' + kind; }
  }

  async function parseBinary(path) {
    filePath = path;
    container.querySelector('#sections-file').textContent = path;
    container.querySelector('#sections-body').innerHTML =
      '<div class="sections-placeholder">parsing…</div>';

    if (unsubscribe) unsubscribe();
    unsubscribe = window.api.disasm.onEvent((payload) => {
      if (payload.id !== currentJobId) return;
      if (payload.type === 'structure') {
        renderStructure(payload.structure);
      } else if (payload.type === 'error') {
        setStatus('error: ' + payload.error, 'error');
        container.querySelector('#sections-body').innerHTML =
          `<div class="sections-placeholder error">${payload.error}</div>`;
      } else if (payload.type === 'done') {
        setStatus('parsed', 'success');
      }
    });

    currentJobId = await window.api.disasm.parse({ filePath: path });
  }

  function renderStructure(structure) {
    const { format, entry, sections, symbols } = structure;
    setStatus(`${format} · entry 0x${entry.toString(16)} · ${sections.length} sections · ${symbols.length} symbols`);

    // Keep symbols in a module-level cache for the symbols tab
    window.__lastStructure = structure;

    const body = container.querySelector('#sections-body');
    body.innerHTML = '';

    // Sections table
    const secTitle = document.createElement('div');
    secTitle.className = 'sections-heading';
    secTitle.textContent = 'Sections';
    body.appendChild(secTitle);

    const secTable = document.createElement('table');
    secTable.className = 'sections-table';
    secTable.innerHTML = `
      <thead>
        <tr>
          <th>Name</th>
          <th>VA</th>
          <th>Offset</th>
          <th>Size</th>
          <th>Entropy</th>
          <th></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = secTable.querySelector('tbody');
    for (const s of sections) {
      const tr = document.createElement('tr');
      tr.dataset.name = s.name;
      tr.dataset.va = s.virtualAddress;
      tr.dataset.offset = s.fileOffset;
      tr.dataset.size = s.size;
      const entropyClass = s.entropy != null && s.entropy > 7.0 ? 'entropy-high' : (s.entropy != null && s.entropy > 6.0 ? 'entropy-mid' : '');
      tr.innerHTML = `
        <td class="sec-name ${s.isCode ? 'is-code' : ''}">${s.name}</td>
        <td class="sec-va">0x${s.virtualAddress.toString(16)}</td>
        <td class="sec-off">0x${s.fileOffset.toString(16)}</td>
        <td class="sec-size">${s.size.toLocaleString()}</td>
        <td class="sec-entropy ${entropyClass}">${s.entropy != null ? s.entropy.toFixed(2) : '—'}</td>
        <td class="sec-actions">
          <button class="sec-disasm" title="Disassemble this section">Disasm</button>
          <button class="sec-hex" title="View this section in hex">Hex</button>
        </td>
      `;
      tr.querySelector('.sec-disasm').addEventListener('click', () => {
        // Dispatch a scoped disasm request to the disasm tab
        window.dispatchEvent(new CustomEvent('disasm:section', {
          detail: { filePath, section: s },
        }));
        Panel.activate('disasm');
      });
      tr.querySelector('.sec-hex').addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('hex:jump', {
          detail: { filePath, offset: s.fileOffset, size: s.size },
        }));
        Panel.activate('hex');
      });
      tbody.appendChild(tr);
    }
    body.appendChild(secTable);
  }

  Panel.registerTab({
    id: 'sections',
    label: 'Sections',
    icon: '▤',
    mount(node) {
      container = node;
      buildShell();
    },
  });
})();

// ── Symbol table tab ────────────────────────────────────
(function registerSymbolsTab() {
  let container = null;
  let searchTerm = '';

  function buildShell() {
    container.innerHTML = `
      <div class="symbols-toolbar">
        <input id="symbols-search" type="text" placeholder="filter symbols…" />
        <select id="symbols-filter">
          <option value="all">All</option>
          <option value="function">Functions</option>
          <option value="import">Imports</option>
          <option value="export">Exports</option>
        </select>
        <span class="symbols-count" id="symbols-count"></span>
      </div>
      <div class="symbols-body" id="symbols-body">
        <div class="sections-placeholder">
          Open a binary in the Sections tab first — symbols load from there.
        </div>
      </div>
    `;
    container.querySelector('#symbols-search').addEventListener('input', (e) => {
      searchTerm = e.target.value.toLowerCase();
      render();
    });
    container.querySelector('#symbols-filter').addEventListener('change', render);
  }

  function render() {
    const structure = window.__lastStructure;
    const body = container.querySelector('#symbols-body');
    if (!structure) {
      body.innerHTML = '<div class="sections-placeholder">No binary loaded — use the Sections tab first.</div>';
      return;
    }

    const filterMode = container.querySelector('#symbols-filter').value;
    const symbols = structure.symbols.filter((s) => {
      if (searchTerm && !s.name.toLowerCase().includes(searchTerm)) return false;
      if (filterMode === 'function' && !s.isFunction) return false;
      if (filterMode === 'import' && !s.isImport) return false;
      if (filterMode === 'export' && !s.isExport) return false;
      return true;
    });

    container.querySelector('#symbols-count').textContent =
      `${symbols.length} / ${structure.symbols.length}`;

    if (!symbols.length) {
      body.innerHTML = '<div class="sections-placeholder">No symbols match.</div>';
      return;
    }

    // Virtualized-ish: cap at 500 rows for now
    const visible = symbols.slice(0, 500);
    const table = document.createElement('table');
    table.className = 'symbols-table';
    table.innerHTML = `
      <thead><tr><th>Name</th><th>Address</th><th>Size</th><th>Type</th><th></th></tr></thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    for (const s of visible) {
      const tr = document.createElement('tr');
      const badges = [];
      if (s.isFunction) badges.push('<span class="sym-badge fn">fn</span>');
      if (s.isImport)   badges.push('<span class="sym-badge imp">imp</span>');
      if (s.isExport)   badges.push('<span class="sym-badge exp">exp</span>');
      tr.innerHTML = `
        <td class="sym-name">${s.name}</td>
        <td class="sym-addr">0x${s.address.toString(16)}</td>
        <td class="sym-size">${s.size || ''}</td>
        <td class="sym-type">${badges.join(' ') || s.type}</td>
        <td><button class="sym-goto" title="Disassemble from here">→</button></td>
      `;
      tr.querySelector('.sym-goto').addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('disasm:goto', {
          detail: { address: s.address, name: s.name },
        }));
        Panel.activate('disasm');
      });
      tbody.appendChild(tr);
    }
    body.replaceChildren(table);
  }

  Panel.registerTab({
    id: 'symbols',
    label: 'Symbols',
    icon: '⚑',
    mount(node) {
      container = node;
      buildShell();
      render();
      // Re-render when a new binary is parsed
      window.addEventListener('binary-parsed', render);
    },
  });

  // Hook into the sections tab's parse completion
  window.addEventListener('binary-parsed', () => render());
})();

// ── Disassembly tab ─────────────────────────────────────
(function registerDisasmTab() {
  if (typeof Panel === "undefined") return;
  if (Panel.tabs.has('disasm')) return;

  let container = null;
  let instructions = [];
  const rowHeight = 20;
  let viewport = null;
  let spacer = null;
  let rowsLayer = null;
  let currentJobId = null;
  let unsubscribe = null;
  const RENDER_MARGIN = 10;

  const MNEMONIC_GROUPS = [
    { re: /^(call|jmp|je|jne|jz|jnz|jg|jge|jl|jle|ja|jae|jb|jbe|js|jns|jo|jno|jp|jnp|jcxz|jecxz|jrcxz|loop[a-z]*|ret[a-z]*|iret[a-z]*|syscall|sysenter|int|int3|ud2)$/i, cls: 'mn-flow' },
    { re: /^(push[a-z]*|pop[a-z]*|enter|leave)$/i, cls: 'mn-stack' },
    { re: /^(add|sub|adc|sbb|mul|imul|div|idiv|inc|dec|neg|cmp|test|and|or|xor|not|shl|shr|sal|sar|rol|ror|rcl|rcr|bt[a-z]*|bs[fr])$/i, cls: 'mn-arith' },
    { re: /^(mov[a-z]*|lea|xchg|cmov[a-z]*|cbw|cwde|cdqe|cwd|cdq|cqo|bswap|stos[a-z]*|lods[a-z]*|scas[a-z]*|cmps[a-z]*|rep[a-z]*)$/i, cls: 'mn-mov' },
    { re: /^(f[a-z0-9]+|v?[a-z]+p[sd][a-z0-9]*|v?mov[a-z0-9]*|aes[a-z]+|sha[a-z]+)$/i, cls: 'mn-vec' },
    { re: /^(nop|hlt|pause|cpuid|rdtsc|in|out|cli|sti|clc|stc|cmc|lahf|sahf)$/i, cls: 'mn-misc' },
  ];

  const REGISTER_RE = /^(r(1[0-5]|[0-9])[dwb]?|e(ax|bx|cx|dx|si|di|sp|bp|ip)|(a|b|c|d)[lhx]|[sd]il?|[sb]pl?|rip|eip|ip|rflags?|eflags?|xmm\d{1,2}|ymm\d{1,2}|zmm\d{1,2}|mm\d|st\d?|cr\d|dr\d|k\d)$/i;

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function tokenizeOperands(opStr) {
    if (!opStr) return '';
    const s = escapeHtml(opStr);
    const parts = s.split(/(\s*,\s*)/);
    const out = [];
    for (const part of parts) {
      if (/^\s*,\s*$/.test(part)) { out.push(part); continue; }
      if (part.includes('[')) {
        const prefixMatch = part.match(/^([a-z]+)\s+/i);
        let pre = '';
        if (prefixMatch) pre = `<span class="tk-size">${prefixMatch[1]}</span> `;
        const inner = part.replace(/^[a-z]+\s+/i, '');
        const colored = inner.replace(/\[([^\]]*)\]/, (_m, body) => {
          const bodyHtml = body
            .replace(/([a-z][a-z0-9]*)/gi, (reg) => REGISTER_RE.test(reg) ? `<span class="tk-reg">${reg}</span>` : reg)
            .replace(/\b(0x[0-9a-f]+|\d+)\b/gi, '<span class="tk-num">$1</span>');
          return `<span class="tk-mem">[</span>${bodyHtml}<span class="tk-mem">]</span>`;
        });
        out.push(pre + colored);
        continue;
      }
      if (REGISTER_RE.test(part))   { out.push(`<span class="tk-reg">${part}</span>`); continue; }
      if (/^(\$|-)?0x[0-9a-f]+$/i.test(part)) { out.push(`<span class="tk-hex">${part}</span>`); continue; }
      if (/^(\$|-)?\d+$/.test(part)) { out.push(`<span class="tk-num">${part}</span>`); continue; }
      if (/^".*"$/.test(part) || /^'.*'$/.test(part)) { out.push(`<span class="tk-str">${part}</span>`); continue; }
      if (/^[a-z_][a-z0-9_@.]*$/i.test(part)) { out.push(`<span class="tk-sym">${part}</span>`); continue; }
      out.push(part);
    }
    return out.join('');
  }

  function mnemonicClass(mn) {
    for (const g of MNEMONIC_GROUPS) if (g.re.test(mn)) return g.cls;
    return 'mn-other';
  }

  function makeRow(insn) {
    const row = document.createElement('div');
    row.className = 'disasm-row';
    row.dataset.address = insn.address;
    const addr = insn.address.toString(16).padStart(8, '0');
    row.innerHTML = `
      <span class="addr">${addr}</span>
      <span class="bytes">${escapeHtml(insn.bytes || '')}</span>
      <span class="mnemonic"><span class="${mnemonicClass(insn.mnemonic)}">${escapeHtml(insn.mnemonic)}</span></span>
      <span class="opStr">${tokenizeOperands(insn.opStr)}</span>
    `;
    const opHex = (insn.opStr || '').match(/0x([0-9a-f]+)/i);
    if (opHex && /^(call|j[a-z]+|loop[a-z]*)$/i.test(insn.mnemonic)) {
      row.classList.add('has-target');
      row.addEventListener('click', () => {
        const target = parseInt(opHex[1], 16);
        const idx = instructions.findIndex((x) => x.address === target);
        if (idx >= 0 && viewport) viewport.scrollTop = idx * rowHeight;
      });
    }
    return row;
  }

  function renderWindow() {
    if (!viewport || !rowsLayer) return;
    const total = instructions.length;
    if (!total) return;
    const scrollTop = viewport.scrollTop;
    const viewH = viewport.clientHeight;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - RENDER_MARGIN);
    const last = Math.min(total - 1, Math.ceil((scrollTop + viewH) / rowHeight) + RENDER_MARGIN);
    rowsLayer.style.transform = `translateY(${first * rowHeight}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) frag.appendChild(makeRow(instructions[i]));
    rowsLayer.replaceChildren(frag);
  }

  function setStatus(text, kind = '') {
    const el = container && container.querySelector('#disasm-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'disasm-status ' + kind;
  }

  async function runDisasm(filePath, opts = {}) {
    container.querySelector('#disasm-file').textContent = filePath +
      (opts.section ? ` [${opts.section.name}]` : '');
    instructions = [];
    rowsLayer.replaceChildren();
    spacer.style.height = '0px';
    setStatus('disassembling…');

    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    let jumpPending = opts.jumpAddr ?? null;

    unsubscribe = window.api.disasm.onEvent((payload) => {
      if (payload.id !== currentJobId) return;
      if (payload.type === 'meta') {
        setStatus(`${payload.format} · ${payload.bits}-bit · ${payload.size.toLocaleString()} bytes`);
      } else if (payload.type === 'chunk') {
        instructions.push(...payload.instructions);
        spacer.style.height = `${instructions.length * rowHeight}px`;
        renderWindow();
        if (jumpPending !== null) {
          const idx = instructions.findIndex(x => x.address === jumpPending);
          if (idx >= 0) { viewport.scrollTop = idx * rowHeight; jumpPending = null; }
        }
      } else if (payload.type === 'done') {
        setStatus(`${payload.total.toLocaleString()} instructions · ${payload.elapsed} ms`, 'success');
      } else if (payload.type === 'error') {
        setStatus(`error: ${payload.error}`, 'error');
      }
    });

    try {
      currentJobId = await window.api.disasm.start({
        filePath,
        offset: opts.offset,
        length: opts.length,
        baseAddr: opts.baseAddr,
      });
    } catch (err) {
      setStatus(`error: ${err.message}`, 'error');
    }
  }

  Panel.registerTab({
    id: 'disasm',
    label: 'Disassembly',
    icon: '{}',
    mount(node) {
      container = node;
      container.innerHTML = `
        <div class="disasm-toolbar">
          <button id="disasm-pick">Open Binary…</button>
          <span class="disasm-file" id="disasm-file">no file</span>
          <span class="disasm-status" id="disasm-status"></span>
        </div>
        <div class="disasm-viewport" id="disasm-viewport">
          <div class="disasm-spacer" id="disasm-spacer"></div>
          <div class="disasm-rows" id="disasm-rows"></div>
        </div>
      `;
      viewport = container.querySelector('#disasm-viewport');
      spacer = container.querySelector('#disasm-spacer');
      rowsLayer = container.querySelector('#disasm-rows');
      viewport.addEventListener('scroll', renderWindow, { passive: true });
      new ResizeObserver(renderWindow).observe(viewport);

      container.querySelector('#disasm-pick').addEventListener('click', async () => {
        const p = await window.api.openBinary();
        if (p) runDisasm(p);
      });
      container.querySelector('#disasm-pick').addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const manual = prompt('Binary path:');
        if (manual) runDisasm(manual);
      });
    },
  });

  window.addEventListener('disasm:section', (e) => {
    const { filePath: fp, section } = e.detail;
    runDisasm(fp, { offset: section.fileOffset, length: section.size, baseAddr: section.virtualAddress, section });
  });

  window.addEventListener('disasm:goto', (e) => {
    const { address } = e.detail;
    const idx = instructions.findIndex(x => x.address === address);
    if (idx >= 0 && viewport) viewport.scrollTop = idx * rowHeight;
  });

  window.__disasmTab = { runDisasm };
})();
