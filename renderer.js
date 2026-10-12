const $ = (id) => document.getElementById(id);

const fileTree      = $('file-tree');
const folderName    = $('folder-name');
const currentFile   = $('current-file');
const dirtyDot      = $('dirty-dot');
const statusMsg     = $('status-msg');
const statusLang    = $('status-lang');
const statusPos     = $('status-pos');
const openFolderBtn = $('open-folder-btn');

let monacoEditor = null;
let rootFolder = null;
let activeFilePath = null;
let isDirty = false;
let savedContent = '';

function setStatus(text, kind = '') {
  statusMsg.textContent = text;
  statusMsg.className = 'msg ' + kind;
}
function setDirty(d) {
  isDirty = d;
  dirtyDot.classList.toggle('visible', d);
}
function langFromPath(p) {
  if (!p) return 'plaintext';
  const ext = p.split('.').pop().toLowerCase();
  return {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    json: 'json', html: 'html', htm: 'html', css: 'css',
    md: 'markdown', txt: 'plaintext', py: 'python',
    sh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini',
    rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp',
  }[ext] || 'plaintext';
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

  monacoEditor.onDidChangeModelContent(() => {
    setDirty(monacoEditor.getValue() !== savedContent);
  });

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

async function openFile(filePath, el) {
  if (isDirty && !confirm('You have unsaved changes. Discard them?')) return;

  const result = await window.api.readFile(filePath);
  if (!result.ok) {
    setStatus(`Failed to read: ${result.error}`, 'error');
    return;
  }

  const language = langFromPath(filePath);
  monacoEditor.setValue(result.content);
  monaco.editor.setModelLanguage(monacoEditor.getModel(), language);

  savedContent = result.content;
  activeFilePath = filePath;
  setDirty(false);

  currentFile.textContent = filePath.split('/').pop();
  statusLang.textContent = language;
  setStatus(filePath);

  document.querySelectorAll('.tree-item.active').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}

async function saveCurrent() {
  const content = monacoEditor.getValue();

  if (!activeFilePath) {
    const filePath = await window.api.saveAs(content);
    if (!filePath) { setStatus('Save cancelled.'); return; }
    activeFilePath = filePath;
    currentFile.textContent = filePath.split('/').pop();
    statusLang.textContent = langFromPath(filePath);
  } else {
    const result = await window.api.writeFile(activeFilePath, content);
    if (!result.ok) { setStatus(`Save failed: ${result.error}`, 'error'); return; }
  }

  savedContent = content;
  setDirty(false);
  setStatus(`Saved: ${activeFilePath}`, 'success');

  if (rootFolder && activeFilePath.startsWith(rootFolder)) {
    await loadFolder(rootFolder);
  }
}


async function saveAsCurrent() {
  if (!monacoEditor) return;
  const content = monacoEditor.getValue();
  const filePath = await window.api.saveAs(content);
  if (!filePath) { setStatus('Save As cancelled.'); return; }

  activeFilePath = filePath;
  currentFile.textContent = filePath.split('/').pop();
  statusLang.textContent = langFromPath(filePath);
  savedContent = content;
  setDirty(false);
  setStatus(`Saved: ${filePath}`, 'success');

  if (rootFolder && filePath.startsWith(rootFolder)) {
    await loadFolder(rootFolder);
  }
}

openFolderBtn.addEventListener('click', async () => {
  if (isDirty && !confirm('You have unsaved changes. Discard them?')) return;
  const folder = await window.api.openFolder();
  if (folder) await loadFolder(folder);
});


window.addEventListener('beforeunload', (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Application menu events ────────────────────────────
window.api.onMenuOpenFolder(async () => {
  if (isDirty && !confirm('You have unsaved changes. Discard them?')) return;
  const folder = await window.api.openFolder();
  if (folder) await loadFolder(folder);
});

window.api.onMenuOpenFile(async () => {
  // Uses the existing folder dialog; if you add a file dialog later, swap here.
  if (isDirty && !confirm('You have unsaved changes. Discard them?')) return;
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

// ── Disassembly tab ─────────────────────────────────────
(function registerDisasmTab() {
  let container = null;
  let instructions = [];
  const rowHeight = 20;
  let viewport = null;
  let spacer = null;
  let rowsLayer = null;
  let currentJobId = null;
  let unsubscribe = null;
  const RENDER_MARGIN = 10;

    function makeRow(insn) {
    const row = document.createElement('div');
    row.className = 'disasm-row';
    row.dataset.address = insn.address;

    const addr = insn.address.toString(16).padStart(8, '0');
    const bytesHtml = escapeHtml(insn.bytes || '');
    const mnHtml = `<span class="${mnemonicClass(insn.mnemonic)}">${escapeHtml(insn.mnemonic)}</span>`;
    const opsHtml = tokenizeOperands(insn.opStr);

    row.innerHTML = `
      <span class="addr">${addr}</span>
      <span class="bytes">${bytesHtml}</span>
      <span class="mnemonic">${mnHtml}</span>
      <span class="opStr">${opsHtml}</span>
    `;
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

  async function runDisasm(filePath) {
    container.querySelector('#disasm-file').textContent = filePath;
    instructions = [];
    rowsLayer.replaceChildren();
    spacer.style.height = '0px';
    setStatus('disassembling…');

    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    unsubscribe = window.api.disasm.onEvent((payload) => {
      if (payload.id !== currentJobId) return;
      if (payload.type === 'meta') {
        setStatus(`${payload.format} · ${payload.bits}-bit · ${payload.size.toLocaleString()} bytes`);
      } else if (payload.type === 'chunk') {
        instructions.push(...payload.instructions);
        spacer.style.height = `${instructions.length * rowHeight}px`;
        renderWindow();
      } else if (payload.type === 'done') {
        setStatus(`${payload.total.toLocaleString()} instructions · ${payload.elapsed} ms`, 'success');
      } else if (payload.type === 'error') {
        setStatus(`error: ${payload.error}`, 'error');
      }
    });

    try {
      currentJobId = await window.api.disasm.start({ filePath });
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
        const filePath = await window.api.openBinary();
        if (!filePath) return;
        runDisasm(filePath);
      });
    },
  });
})();
