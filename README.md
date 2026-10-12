# Ryekit

A reverse-engineering Swiss Army knife — editor, terminal, disassembler, hex viewer, and binary analysis tools in one Electron app.

Built for poking at binaries: open a file, read its sections, follow the code, inspect the bytes, and drive everything from a single window.

## Features

### Editor
- **Monaco editor** (the engine behind VS Code) with GitHub Dark theme
- **Cascadia Code** bundled, with ligatures
- **Multi-tab editing** — per-tab undo, cursor position, and scroll state
- **Binary detection** — images, archives, executables, and unknown binaries are skipped in the tree

### File tree
- Recursive folder browser, lazy-loaded
- Ignores `node_modules`, `.git`, `dist`, `build`, `.next`, and dotfiles by default
- Binary files greyed out and non-clickable

### Terminal
- **Integrated bash** via `node-pty` (real PTY, so `vim`, `htop`, `top` all work)
- **xterm.js** frontend with a GitHub Dark color scheme
- Drag-to-resize, maximizable

### Disassembler
- **Capstone** via `capstone-wasm` — no native build, no `node-pty`-style rebuild pain
- Runs in a **separate utility process** — a bad binary can't freeze the UI
- Multi-arch: **x86, x86_64, ARM, ARM64, MIPS, PowerPC, SPARC, M68K**
- **Syntax highlighting** by mnemonic category (flow, stack, arithmetic, data movement, vector)
- **Click-to-follow** jumps
- **Virtualized rendering** — smooth with hundreds of thousands of instructions

### Hex viewer
- Virtual scrolling over the whole file
- **64 KB chunked reads** — never loads the full file into memory
- Address / hex / ASCII columns, printable bytes highlighted

### Sections & Symbols
- **ELF, PE, Mach-O** parsing via `node-lief`
- **Section browser** with VA, file offset, size, and Shannon entropy per section
- **Disassemble** or **Hex** a single section without touching the rest of the file
- **Symbol table** with import / export / function filters and jump-to-address

## Getting started

```bash
git clone https://github.com/ADevWhoLikesCats/ryekit.git
cd ryekit
npm install
npm start
