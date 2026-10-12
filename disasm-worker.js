// disasm-worker.js — runs in Electron utilityProcess
// Uses @alexaltea/capstone-js (WASM) for architecture-agnostic disassembly.

const fs = require('fs');
const { Const, Capstone, loadCapstone } = require('capstone-wasm');

let CAPSTONE = null;
async function getCapstone() {
  if (!CAPSTONE) CAPSTONE = await loadCapstone();
  return CAPSTONE;
}

// ── Binary format sniffing ─────────────────────────────
// Returns: { kind: 'x86'|'x86_64'|'arm'|'arm64'|..., format, bits }
// arch/mode strings are resolved to Capstone constants later.
function sniff(bytes) {
  // ELF
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    const ei_class = bytes[4];       // 1 = 32-bit, 2 = 64-bit
    const ei_data  = bytes[5];       // 1 = LE, 2 = BE
    const e_machine = ei_data === 1
      ? bytes.readUInt16LE(18)
      : bytes.readUInt16BE(18);

    const map = {
      0x03:  { kind: 'x86',   bits: ei_class === 2 ? 64 : 32 },
      0x3e:  { kind: 'x86_64', bits: 64 },
      0x28:  { kind: 'arm',   bits: 32 },
      0xb7:  { kind: 'arm64', bits: 64 },
      0x08:  { kind: 'mips',  bits: 32 },
      0x14:  { kind: 'ppc',   bits: 32 },
      0x15:  { kind: 'ppc',   bits: 64 },
      0x2b:  { kind: 'sparc', bits: 32 },
      0x04:  { kind: 'm68k',  bits: 32 },
    };
    const m = map[e_machine];
    if (m) return { ...m, format: 'ELF' };
    return { error: `unsupported ELF machine 0x${e_machine.toString(16)}` };
  }

  // PE (MZ … "PE\0\0")
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOff = bytes.readUInt32LE(0x3c);
    if (bytes[peOff] === 0x50 && bytes[peOff + 1] === 0x45) {
      const machine = bytes.readUInt16LE(peOff + 4);
      const map = {
        0x014c: { kind: 'x86',   bits: 32 },
        0x8664: { kind: 'x86_64', bits: 64 },
        0x01c0: { kind: 'arm',   bits: 32 },
        0xaa64: { kind: 'arm64', bits: 64 },
      };
      const m = map[machine];
      if (m) return { ...m, format: 'PE' };
      return { error: `unsupported PE machine 0x${machine.toString(16)}` };
    }
  }

  // Mach-O (thin — fat Mach-O would need slice pick)
  const magic = bytes.readUInt32BE(0);
  const map = {
    0xfeedface: { kind: 'x86',   bits: 32 },
    0xfeedfacf: { kind: 'x86_64', bits: 64 },
    0xcefaedfe: { kind: 'x86',   bits: 32 },
    0xcffaedfe: { kind: 'x86_64', bits: 64 },
  };
  if (map[magic]) return { ...map[magic], format: 'Mach-O' };

  return { error: 'unrecognized binary format' };
}


// ── Map our "kind"/"bits" to capstone-wasm Const values ─
function resolveArchMode(info) {
  const { Const } = require('capstone-wasm');

  const archTable = {
    x86:    Const.CS_ARCH_X86,
    x86_64: Const.CS_ARCH_X86,
    arm:    Const.CS_ARCH_ARM,
    arm64:  Const.CS_ARCH_ARM64,
    mips:   Const.CS_ARCH_MIPS,
    ppc:    Const.CS_ARCH_PPC,
    sparc:  Const.CS_ARCH_SPARC,
    m68k:   Const.CS_ARCH_M68K,
  };

  let mode;
  if (info.kind === 'x86') {
    mode = info.bits === 64 ? Const.CS_MODE_64 : Const.CS_MODE_32;
  } else if (info.kind === 'x86_64') {
    mode = Const.CS_MODE_64;
  } else if (info.kind === 'arm') {
    mode = Const.CS_MODE_ARM;
  } else if (info.kind === 'arm64') {
    mode = Const.CS_MODE_ARM;
  } else if (info.kind === 'mips') {
    mode = Const.CS_MODE_MIPS32;
  } else if (info.kind === 'ppc') {
    mode = info.bits === 64 ? Const.CS_MODE_PPC64 : Const.CS_MODE_PPC32;
  } else if (info.kind === 'sparc') {
    mode = Const.CS_MODE_SPARC32;
  } else if (info.kind === 'm68k') {
    mode = Const.CS_MODE_BIG_ENDIAN;
  }

  const arch = archTable[info.kind];
  if (arch === undefined || mode === undefined) {
    throw new Error(`no capstone-wasm mapping for ${info.kind}/${info.bits}`);
  }
  return { arch, mode };
}



// ── Binary structure parsing via LIEF ───────────────────
function parseBinaryStructure(filePath) {
  const lief = require('node-lief');
  const isELF = filePath.endsWith('.so') || filePath.endsWith('.elf') ||
                /^ELF/.test(require('fs').readFileSync(filePath, { length: 4 }).toString('hex'));
  // Try each format in order
  let bin = null, format = null;
  try { bin = lief.ELF.parse(filePath); format = 'ELF'; } catch {}
  if (!bin) { try { bin = lief.PE.parse(filePath); format = 'PE'; } catch {} }
  if (!bin) { try { bin = lief.MachO.parse(filePath); format = 'Mach-O'; } catch {} }
  if (!bin) throw new Error('Could not parse binary format');

  // Sections: name, VA, offset, size, flags
  const sections = (bin.sections || []).map((s) => ({
    name: s.name,
    virtualAddress: Number(s.virtualAddress ?? s.virtual_address ?? 0),
    fileOffset: Number(s.fileOffset ?? s.file_offset ?? 0),
    size: Number(s.size ?? s.virtual_size ?? 0),
    entropy: typeof s.entropy === 'function' ? s.entropy() : (s.entropy ?? null),
    isCode: typeof s.has === 'function' && s.has(lief.ELF.SECTION_FLAGS.EXECINSTR),
  }));

  // Symbols: name, addr, size, type
  const symbols = (bin.symbols || []).slice(0, 5000).map((sym) => ({
    name: sym.name || `sym_${sym.value?.toString(16)}`,
    address: Number(sym.value ?? 0),
    size: Number(sym.size ?? 0),
    type: sym.type !== undefined ? String(sym.type) : 'unknown',
    isFunction: !!(sym.isFunction || sym.is_function),
    isImport: !!(sym.isImport || sym.is_import),
    isExport: !!(sym.isExport || sym.is_export),
  }));

  // Entry point
  const entry = Number(bin.entrypoint ?? bin.entry_point ?? 0);

  return { format, entry, sections, symbols };
}

// ── Message loop ───────────────────────────────────────
process.parentPort.on('message', async (e) => {
  const msg = e.data;
  const {
    id,
    filePath,
    baseAddr = 0x1000,
    maxInsns = 200000,
    chunkSize = 5000,
    action = 'disasm',
  } = msg;

  const post = (payload) => process.parentPort.postMessage({ id, ...payload });

  // ── Parse-only job (section + symbol extraction) ──
  if (action === 'parse') {
    try {
      const structure = parseBinaryStructure(filePath);
      post({ type: 'structure', structure });
      post({ type: 'done', total: 0, elapsed: 0 });
    } catch (err) {
      post({ type: 'error', error: err.message || String(err) });
    }
    return;
  }

  try {
    if (!fs.existsSync(filePath)) {
      return post({ type: 'error', error: `File not found: ${filePath}` });
    }

    let bytes = fs.readFileSync(filePath);
    // If the caller scoped us to a byte range (e.g. one section), slice it.
    if (msg.offset !== undefined && msg.length !== undefined) {
      bytes = bytes.subarray(msg.offset, msg.offset + msg.length);
    }
    const info = sniff(bytes);
    if (info.error) {
      return post({ type: 'error', error: info.error });
    }

    post({
      type: 'meta',
      format: info.format,
      arch: info.kind,
      bits: info.bits,
      size: bytes.length,
    });

    const capstone = await getCapstone();
    const { arch, mode } = resolveArchMode(info);

    // API: new Capstone(arch, mode) — synchronous, returns instance
    const cs = new Capstone(arch, mode);

    const t0 = Date.now();
    // WASM API: disasm(buffer, address) — synchronous
    const rawInsns = cs.disasm(bytes, { address: baseAddr });
    const elapsed = Date.now() - t0;

    const total = Math.min(rawInsns.length, maxInsns);

    for (let i = 0; i < total; i += chunkSize) {
      const slice = rawInsns.slice(i, i + chunkSize).map((insn) => ({
        address: insn.address,
        size: insn.size,
        bytes: typeof insn.bytes === 'string'
          ? insn.bytes
          : Buffer.from(insn.bytes || []).toString('hex'),
        mnemonic: insn.mnemonic,
        opStr: insn.opStr ?? insn.op_str ?? '',
      }));
      post({ type: 'chunk', from: i, instructions: slice });
    }

    post({ type: 'done', total, elapsed });

    try { cs.close && cs.close(); } catch {}
  } catch (err) {
    post({ type: 'error', error: err.message || String(err) });
  }
});
