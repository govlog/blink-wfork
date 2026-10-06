class Manifest {
  abi;
  version;
  types;
  constructor(raw) {
    this.abi = raw.abi;
    this.version = String(raw.library_version ?? "");
    this.types = raw.types;
    if (raw.schema !== 1) throw new Error(`ghostty manifest: unsupported schema ${raw.schema}`);
    if (this.abi.pointer_size !== 4 || this.abi.endian !== "little") throw new Error("ghostty manifest: expected wasm32 little-endian ABI");
  }
  /** Read and parse the manifest from a live wasm instance. */
  static read(exports) {
    const ptr = exports.ghostty_type_json();
    const mem = new Uint8Array(exports.memory.buffer);
    let end = ptr;
    while (mem[end] !== 0) end++;
    return new Manifest(JSON.parse(new TextDecoder().decode(mem.subarray(ptr, end))));
  }
  type(name) {
    const t = this.types[name];
    if (!t) throw new Error(`ghostty manifest: unknown type ${name}`);
    return t;
  }
  struct(name) {
    const t = this.type(name);
    if (t.kind !== "struct" && t.kind !== "union") throw new Error(`ghostty manifest: ${name} is a ${t.kind}, not a struct`);
    return t;
  }
  size(name) {
    return this.type(name).size;
  }
  field(structName, fieldName) {
    const f = this.struct(structName).fields[fieldName];
    if (!f) throw new Error(`ghostty manifest: no field ${structName}.${fieldName}`);
    return f;
  }
  enumv(typeName, member) {
    const t = this.type(typeName);
    if (t.kind !== "enum") throw new Error(`ghostty manifest: ${typeName} is not an enum`);
    const v = t.values[member];
    if (v === void 0) throw new Error(`ghostty manifest: no enum member ${typeName}.${member}`);
    return v;
  }
  packed(name) {
    const t = this.type(name);
    if (t.kind !== "packed") throw new Error(`ghostty manifest: ${name} is not packed`);
    return t;
  }
  bits(packedName, bitName) {
    const b = this.packed(packedName).bits[bitName];
    if (!b) throw new Error(`ghostty manifest: no bits ${packedName}.${bitName}`);
    return b;
  }
  /** Sub-layout of a packed union arm, e.g. arm("GhosttyCell", "content", "CODEPOINT"). */
  arm(packedName, bitName, armName) {
    const b = this.bits(packedName, bitName);
    const a = b.arms?.[armName];
    if (!a) throw new Error(`ghostty manifest: no arm ${packedName}.${bitName}.${armName}`);
    return a;
  }
}
class Mem {
  constructor(ex, manifest) {
    this.ex = ex;
    this.manifest = manifest;
  }
  buf = null;
  u8v;
  dv;
  scratchPtr = 0;
  scratchLen = 0;
  dec = new TextDecoder();
  enc = new TextEncoder();
  u8() {
    const b = this.ex.memory.buffer;
    if (b !== this.buf) {
      this.buf = b;
      this.u8v = new Uint8Array(b);
      this.dv = new DataView(b);
    }
    return this.u8v;
  }
  view() {
    this.u8();
    return this.dv;
  }
  alloc(n) {
    const p = this.ex.ghostty_wasm_alloc(n);
    if (p === 0 && n > 0) throw new Error("libghostty-vt: out of memory");
    return p;
  }
  free(p, n) {
    if (p) this.ex.ghostty_wasm_free(p, n);
  }
  allocOpaque() {
    const s = this.ex.ghostty_wasm_alloc_opaque();
    if (!s) throw new Error("libghostty-vt: out of memory");
    return s;
  }
  takeOpaque(slot) {
    return this.ex.ghostty_wasm_take_opaque(slot);
  }
  freeOpaque(slot) {
    this.ex.ghostty_wasm_free_opaque(slot);
  }
  /** Run fn with a fresh opaque slot, free it afterwards. */
  withOpaque(fn) {
    const s = this.allocOpaque();
    try {
      return fn(s);
    } finally {
      this.freeOpaque(s);
    }
  }
  /** Allocate a zero-filled "sized struct" with its size field set. Caller frees with size(name). */
  newSized(structName) {
    const size = this.manifest.size(structName);
    const p = this.alloc(size);
    this.zero(p, size);
    this.setU32(p + this.manifest.field(structName, "size").offset, size);
    return p;
  }
  zero(p, n) {
    this.u8().fill(0, p, p + n);
  }
  writeBytes(p, bytes) {
    this.u8().set(bytes, p);
  }
  readBytes(p, len) {
    return this.u8().slice(p, p + len);
  }
  readString(p, len) {
    return this.dec.decode(this.u8().subarray(p, p + len));
  }
  encode(s) {
    return this.enc.encode(s);
  }
  u8At(p) {
    return this.u8()[p];
  }
  u16(p) {
    return this.view().getUint16(p, true);
  }
  u32(p) {
    return this.view().getUint32(p, true);
  }
  i32(p) {
    return this.view().getInt32(p, true);
  }
  u64(p) {
    return Number(this.view().getBigUint64(p, true));
  }
  f64(p) {
    return this.view().getFloat64(p, true);
  }
  bool(p) {
    return this.u8()[p] !== 0;
  }
  rgb(p) {
    const m = this.u8();
    return [m[p], m[p + 1], m[p + 2]];
  }
  setU8(p, v) {
    this.u8()[p] = v;
  }
  setU16(p, v) {
    this.view().setUint16(p, v, true);
  }
  setU32(p, v) {
    this.view().setUint32(p, v >>> 0, true);
  }
  setI32(p, v) {
    this.view().setInt32(p, v, true);
  }
  setU64(p, v) {
    this.view().setBigUint64(p, BigInt(v), true);
  }
  setF64(p, v) {
    this.view().setFloat64(p, v, true);
  }
  setBool(p, v) {
    this.u8()[p] = v ? 1 : 0;
  }
  setRgb(p, rgb) {
    const m = this.u8();
    m[p] = rgb[0];
    m[p + 1] = rgb[1];
    m[p + 2] = rgb[2];
  }
  /** Reusable scratch area (grows, never shrinks). Valid until the next scratch() call. */
  scratch(n) {
    if (n > this.scratchLen) {
      if (this.scratchPtr) this.free(this.scratchPtr, this.scratchLen);
      this.scratchLen = Math.max(n, this.scratchLen * 2, 4096);
      this.scratchPtr = this.alloc(this.scratchLen);
    }
    return this.scratchPtr;
  }
  dispose() {
    if (this.scratchPtr) {
      this.free(this.scratchPtr, this.scratchLen);
      this.scratchPtr = 0;
      this.scratchLen = 0;
    }
  }
}
function uleb(n) {
  const out = [];
  do {
    let b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return out;
}
function section(id, body) {
  return [id, ...uleb(body.length), ...body];
}
function str(s) {
  const b = Array.from(new TextEncoder().encode(s));
  return [...uleb(b.length), ...b];
}
const cache = /* @__PURE__ */ new Map();
function adapterModule(nparams) {
  let bytes = cache.get(nparams);
  if (bytes) return bytes;
  const params = new Array(nparams).fill(127);
  const typeSec = section(1, [1, 96, ...uleb(nparams), ...params, 0]);
  const importSec = section(2, [1, ...str("env"), ...str("cb"), 0, 0]);
  const funcSec = section(3, [1, 0]);
  const exportSec = section(7, [1, ...str("f"), 0, 1]);
  const body = [0];
  for (let i = 0; i < nparams; i++) body.push(32, ...uleb(i));
  body.push(16, 0, 11);
  const codeSec = section(10, [1, ...uleb(body.length), ...body]);
  bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, ...typeSec, ...importSec, ...funcSec, ...exportSec, ...codeSec]);
  cache.set(nparams, bytes);
  return bytes;
}
function installCallback(table, fn, nparams) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(adapterModule(nparams)), { env: { cb: fn } });
  const idx = table.grow(1);
  table.set(idx, instance.exports.f);
  return idx;
}
class Vt {
  constructor(ex, manifest) {
    this.ex = ex;
    this.manifest = manifest;
    this.mem = new Mem(ex, manifest);
    this.table = ex.__indirect_function_table;
  }
  mem;
  table;
  /** Instantiate from bytes or from a fetch() response (streaming when possible). */
  static async load(source) {
    let logFn = () => {
    };
    const imports = { env: { log: (ptr, len) => logFn(ptr, len) } };
    let instance;
    if (source instanceof Uint8Array) instance = (await WebAssembly.instantiate(source, imports)).instance;
    else instance = (await WebAssembly.instantiateStreaming(source, imports)).instance;
    const ex = instance.exports;
    const manifest = Manifest.read(ex);
    const vt = new Vt(ex, manifest);
    logFn = (ptr, len) => console.debug("[ghostty]", vt.mem.readString(ptr, len));
    return vt;
  }
  result(name) {
    return this.manifest.enumv("GhosttyResult", name);
  }
  check(r, what) {
    if (r !== 0) throw new Error(`libghostty-vt: ${what} failed (${r})`);
  }
  /** Take an opaque handle out of a constructor call: fn(slot) must return the result code. */
  handle(what, fn) {
    return this.mem.withOpaque((slot) => {
      this.check(fn(slot), what);
      return this.mem.takeOpaque(slot);
    });
  }
  /** Write a scalar struct field according to its manifest type (aliases and enums resolved). */
  setField(base, struct, field, value) {
    const f = this.manifest.field(struct, field);
    const p = base + f.offset;
    const v = typeof value === "boolean" ? value ? 1 : 0 : value;
    switch (this.prim(f)) {
      case "u8":
      case "bool":
        this.mem.setU8(p, v);
        break;
      case "u16":
      case "i16":
        this.mem.setU16(p, v);
        break;
      case "u32":
      case "i32":
        this.mem.setI32(p, v | 0);
        break;
      case "u64":
      case "i64":
        this.mem.setU64(p, v);
        break;
      case "f64":
        this.mem.setF64(p, v);
        break;
      case "f32":
        this.mem.view().setFloat32(p, v, true);
        break;
      case "pointer":
        this.mem.setU32(p, v);
        break;
      default:
        throw new Error(`setField: unsupported type ${f.type} for ${struct}.${field}`);
    }
  }
  /** Primitive kind of a field: follows aliases, enums map to their underlying integer. */
  prim(f) {
    let t = f.type;
    for (let i = 0; i < 8; i++) {
      if (["u8", "bool", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64", "pointer", "usize"].includes(t)) return t === "usize" ? "u32" : t;
      const info = this.manifest.types?.[t] ?? this.manifestType(t);
      if (!info) return t;
      if (info.kind === "alias") t = info.type;
      else if (info.kind === "enum") t = info.underlying ?? "i32";
      else return t;
    }
    return t;
  }
  manifestType(name) {
    try {
      return this.manifest.type(name);
    } catch {
      return null;
    }
  }
}
class VtTerminal {
  constructor(vt, cols, rows) {
    this.vt = vt;
    this.ex = vt.ex;
    this.mem = vt.mem;
    this.cols = cols;
    this.rows = rows;
    this.OPT = (m) => vt.manifest.enumv("GhosttyTerminalOption", m);
    this.DATA = (m) => vt.manifest.enumv("GhosttyTerminalData", m);
    this.ptr = vt.handle("terminal_new", (slot) => this.ex.ghostty_terminal_new(0, slot, cols, rows));
  }
  ptr;
  cols;
  rows;
  ex;
  mem;
  OPT;
  DATA;
  writeBuf = { ptr: 0, len: 0 };
  ptyOut = null;
  pending = [];
  inWrite = false;
  /** Feed VT bytes. PTY responses produced meanwhile are delivered after this returns. */
  write(bytes) {
    if (bytes.length === 0) return;
    if (bytes.length > this.writeBuf.len) {
      if (this.writeBuf.ptr) this.mem.free(this.writeBuf.ptr, this.writeBuf.len);
      this.writeBuf.len = Math.max(bytes.length, 65536);
      this.writeBuf.ptr = this.mem.alloc(this.writeBuf.len);
    }
    this.mem.writeBytes(this.writeBuf.ptr, bytes);
    this.inWrite = true;
    try {
      this.ex.ghostty_terminal_vt_write(this.ptr, this.writeBuf.ptr, bytes.length);
    } finally {
      this.inWrite = false;
    }
    if (this.pending.length && this.ptyOut) {
      const out = this.pending;
      this.pending = [];
      for (const b of out) this.ptyOut(b);
    }
  }
  resize(cols, rows, cellWidthPx, cellHeightPx) {
    this.vt.check(this.ex.ghostty_terminal_resize(this.ptr, cols, rows, cellWidthPx, cellHeightPx), "terminal_resize");
    this.cols = cols;
    this.rows = rows;
  }
  setPtr(opt, valuePtr) {
    this.vt.check(this.ex.ghostty_terminal_set(this.ptr, this.OPT(opt), valuePtr), `terminal_set ${opt}`);
  }
  setWritePty(fn) {
    this.ptyOut = fn;
    const idx = installCallback(this.vt.table, (_t, _ud, ptr, len) => {
      const bytes = this.mem.readBytes(ptr, len);
      if (this.inWrite) this.pending.push(bytes);
      else fn(bytes);
    }, 4);
    this.setPtr("WRITE_PTY", idx);
  }
  setBell(fn) {
    this.setPtr("BELL", installCallback(this.vt.table, () => fn(), 2));
  }
  setTitleChanged(fn) {
    this.setPtr("TITLE_CHANGED", installCallback(this.vt.table, () => fn(), 2));
  }
  modeCfg(mode, value) {
    const S = "GhosttyTerminalModeConfig";
    const size = this.vt.manifest.size(S);
    const p = this.mem.scratch(size);
    this.mem.zero(p, size);
    this.vt.setField(p, S, "mode", mode);
    this.vt.setField(p, S, "value", value);
    return p;
  }
  /** DEC private mode value (e.g. 1 = application cursor keys, 2004 = bracketed paste). */
  getMode(mode) {
    const p = this.modeCfg(mode, false);
    if (this.ex.ghostty_terminal_get(this.ptr, this.DATA("MODE"), p) !== 0) return false;
    return this.mem.bool(p + this.vt.manifest.field("GhosttyTerminalModeConfig", "value").offset);
  }
  setMode(mode, value) {
    this.setPtr("MODE", this.modeCfg(mode, value));
  }
  scroll(tag, delta = 0) {
    const S = "GhosttyTerminalScrollViewport";
    const size = this.vt.manifest.size(S);
    const p = this.mem.scratch(size);
    this.mem.zero(p, size);
    this.vt.setField(p, S, "tag", this.vt.manifest.enumv("GhosttyTerminalScrollViewportTag", tag));
    if (tag === "DELTA") {
      const value = this.vt.manifest.field(S, "value");
      this.vt.setField(p + value.offset, value.type, "delta", delta);
    }
    this.ex.ghostty_terminal_scroll_viewport(this.ptr, p);
  }
  scrollDelta(lines) {
    if (lines) this.scroll("DELTA", lines | 0);
  }
  scrollTop() {
    this.scroll("TOP");
  }
  scrollBottom() {
    this.scroll("BOTTOM");
  }
  scrollbar() {
    const S = "GhosttyTerminalScrollbar";
    const p = this.mem.scratch(this.vt.manifest.size(S));
    this.vt.check(this.ex.ghostty_terminal_get(this.ptr, this.DATA("SCROLLBAR"), p), "get SCROLLBAR");
    const f = (n) => this.mem.u64(p + this.vt.manifest.field(S, n).offset);
    return { total: f("total"), offset: f("offset"), len: f("len") };
  }
  getBool(data) {
    const p = this.mem.scratch(4);
    this.mem.setU32(p, 0);
    if (this.ex.ghostty_terminal_get(this.ptr, this.DATA(data), p) !== 0) return false;
    return this.mem.bool(p);
  }
  viewportActive() {
    return this.getBool("VIEWPORT_ACTIVE");
  }
  mouseTracking() {
    return this.getBool("MOUSE_TRACKING");
  }
  title() {
    const S = "GhosttyString";
    const p = this.mem.scratch(this.vt.manifest.size(S));
    if (this.ex.ghostty_terminal_get(this.ptr, this.DATA("TITLE"), p) !== 0) return "";
    const ptr = this.mem.u32(p + this.vt.manifest.field(S, "ptr").offset);
    const len = this.mem.u32(p + this.vt.manifest.field(S, "len").offset);
    return len ? this.mem.readString(ptr, len) : "";
  }
  setScrollbackMaxLines(n) {
    const p = this.mem.scratch(4);
    this.mem.setU32(p, n);
    this.setPtr("SCROLLBACK_MAX_LINES", p);
  }
  setColors(c) {
    const one = (opt, rgb) => {
      if (!rgb) return;
      const p = this.mem.scratch(4);
      this.mem.setRgb(p, rgb);
      this.setPtr(opt, p);
    };
    one("COLOR_FOREGROUND", c.fg);
    one("COLOR_BACKGROUND", c.bg);
    one("COLOR_CURSOR", c.cursor);
    if (c.palette) {
      if (c.palette.length !== 256) throw new Error("palette must have 256 entries");
      const p = this.mem.scratch(768);
      for (let i = 0; i < 256; i++) this.mem.setRgb(p + i * 3, c.palette[i]);
      this.setPtr("COLOR_PALETTE", p);
    }
  }
  // ---- selection ------------------------------------------------------------------------
  /** Grid reference of a viewport cell. Returns a pointer to a GhosttyGridRef (free with freeGridRef). */
  gridRefViewport(x, y) {
    const M = this.vt.manifest;
    const P = "GhosttyPoint";
    const size = M.size(P);
    const pp = this.mem.scratch(size);
    this.mem.zero(pp, size);
    this.vt.setField(pp, P, "tag", M.enumv("GhosttyPointTag", "VIEWPORT"));
    const value = M.field(P, "value");
    const coordField = M.field(value.type, "coordinate");
    const coord = pp + value.offset + coordField.offset;
    this.vt.setField(coord, coordField.type, "x", x);
    this.vt.setField(coord, coordField.type, "y", y);
    const ref = this.mem.newSized("GhosttyGridRef");
    const r = this.ex.ghostty_terminal_grid_ref(this.ptr, pp, ref);
    if (r !== 0) {
      this.mem.free(ref, M.size("GhosttyGridRef"));
      throw new Error(`grid_ref failed (${r})`);
    }
    return ref;
  }
  freeGridRef(ref) {
    this.mem.free(ref, this.vt.manifest.size("GhosttyGridRef"));
  }
  /** Build a GhosttySelection at `out` from two grid refs (copies them). */
  fillSelection(out, start, end, rectangle) {
    const M = this.vt.manifest;
    const S = "GhosttySelection";
    const refSize = M.size("GhosttyGridRef");
    this.mem.zero(out, M.size(S));
    this.mem.setU32(out + M.field(S, "size").offset, M.size(S));
    this.mem.u8().copyWithin(out + M.field(S, "start").offset, start, start + refSize);
    this.mem.u8().copyWithin(out + M.field(S, "end").offset, end, end + refSize);
    this.mem.setBool(out + M.field(S, "rectangle").offset, rectangle);
  }
  setSelection(start, end, rectangle = false) {
    const p = this.mem.scratch(this.vt.manifest.size("GhosttySelection"));
    this.fillSelection(p, start, end, rectangle);
    this.setPtr("SELECTION", p);
  }
  clearSelection() {
    this.vt.check(this.ex.ghostty_terminal_set(this.ptr, this.OPT("SELECTION"), 0), "clear selection");
  }
  /** Plain text of the terminal's current selection, null when there is none. */
  selectionText() {
    const M = this.vt.manifest;
    const O = "GhosttyTerminalSelectionFormatOptions";
    const opts = this.mem.newSized(O);
    this.vt.setField(opts, O, "emit", M.enumv("GhosttyFormatterFormat", "PLAIN"));
    this.vt.setField(opts, O, "trim", true);
    this.vt.setField(opts, O, "selection", 0);
    const outPtr = this.mem.allocOpaque();
    const outLen = this.mem.alloc(4);
    try {
      const r = this.ex.ghostty_terminal_selection_format_alloc(this.ptr, 0, opts, outPtr, outLen);
      if (r === this.vt.result("NO_VALUE") || r === this.vt.result("INVALID_VALUE")) return null;
      this.vt.check(r, "selection_format_alloc");
      const ptr = this.mem.takeOpaque(outPtr), len = this.mem.u32(outLen);
      const text = this.mem.readString(ptr, len);
      this.ex.ghostty_free(0, ptr, len);
      return text;
    } finally {
      this.mem.free(outLen, 4);
      this.mem.freeOpaque(outPtr);
      this.mem.free(opts, M.size(O));
    }
  }
  free() {
    if (!this.ptr) return;
    this.ex.ghostty_terminal_free(this.ptr);
    this.ptr = 0;
    if (this.writeBuf.ptr) {
      this.mem.free(this.writeBuf.ptr, this.writeBuf.len);
      this.writeBuf.ptr = 0;
    }
  }
}
class CellDecoder {
  TAG_CODEPOINT;
  TAG_GRAPHEME;
  TAG_BG_PALETTE;
  TAG_BG_RGB;
  WIDE_NARROW;
  WIDE_WIDE;
  WIDE_SPACER_TAIL;
  WIDE_SPACER_HEAD;
  f;
  constructor(manifest) {
    const e = (t, m) => manifest.enumv(t, m);
    this.TAG_CODEPOINT = e("GhosttyCellContentTag", "CODEPOINT");
    this.TAG_GRAPHEME = e("GhosttyCellContentTag", "CODEPOINT_GRAPHEME");
    this.TAG_BG_PALETTE = e("GhosttyCellContentTag", "BG_COLOR_PALETTE");
    this.TAG_BG_RGB = e("GhosttyCellContentTag", "BG_COLOR_RGB");
    this.WIDE_NARROW = e("GhosttyCellWide", "NARROW");
    this.WIDE_WIDE = e("GhosttyCellWide", "WIDE");
    this.WIDE_SPACER_TAIL = e("GhosttyCellWide", "SPACER_TAIL");
    this.WIDE_SPACER_HEAD = e("GhosttyCellWide", "SPACER_HEAD");
    const content = manifest.bits("GhosttyCell", "content");
    const sub = (arm, bit) => {
      const b = manifest.arm("GhosttyCell", "content", arm).bits[bit];
      return { lsb: content.lsb + b.lsb, width: b.width };
    };
    this.f = {
      tag: manifest.bits("GhosttyCell", "content_tag"),
      style: manifest.bits("GhosttyCell", "style_id"),
      wide: manifest.bits("GhosttyCell", "wide"),
      codepoint: sub("CODEPOINT", "codepoint"),
      palette: sub("BG_COLOR_PALETTE", "index"),
      r: sub("BG_COLOR_RGB", "r"),
      g: sub("BG_COLOR_RGB", "g"),
      b: sub("BG_COLOR_RGB", "b")
    };
    for (const k of ["tag", "codepoint", "palette", "r", "g", "b"]) {
      if (this.f[k].lsb + this.f[k].width > 32) throw new Error(`GhosttyCell.${k} crosses the u32 boundary; update CellDecoder`);
    }
  }
  lo(v, k) {
    const f = this.f[k];
    return v >>> f.lsb & 2 ** f.width - 1;
  }
  /** Field possibly spanning both words (style_id, wide): 64-bit extraction without BigInt. */
  any(lo, hi, k) {
    const f = this.f[k];
    if (f.lsb >= 32) return hi >>> f.lsb - 32 & 2 ** f.width - 1;
    if (f.lsb + f.width <= 32) return this.lo(lo, k);
    const lowBits = 32 - f.lsb;
    return (lo >>> f.lsb | (hi & 2 ** (f.width - lowBits) - 1) << lowBits) >>> 0;
  }
  tag(lo, _hi) {
    return this.lo(lo, "tag");
  }
  codepoint(lo, _hi) {
    return this.lo(lo, "codepoint");
  }
  paletteIndex(lo, _hi) {
    return this.lo(lo, "palette");
  }
  rgb(lo, _hi) {
    return [this.lo(lo, "r"), this.lo(lo, "g"), this.lo(lo, "b")];
  }
  styleId(lo, hi) {
    return this.any(lo, hi, "style");
  }
  wide(lo, hi) {
    return this.any(lo, hi, "wide");
  }
}
class RenderState {
  constructor(vt) {
    this.vt = vt;
    this.ex = vt.ex;
    this.mem = vt.mem;
    this.M = vt.manifest;
    this.D = (m) => this.M.enumv("GhosttyRenderStateData", m);
    this.RD = (m) => this.M.enumv("GhosttyRenderStateRowData", m);
    this.CD = (m) => this.M.enumv("GhosttyRenderStateRowCellsData", m);
    this.ptr = vt.handle("render_state_new", (s) => this.ex.ghostty_render_state_new(0, s));
    this.iter = vt.handle("row_iterator_new", (s) => this.ex.ghostty_render_state_row_iterator_new(0, s));
    this.cells = vt.handle("row_cells_new", (s) => this.ex.ghostty_render_state_row_cells_new(0, s));
    for (const [n, m] of [["bar", "BAR"], ["block", "BLOCK"], ["underline", "UNDERLINE"], ["block_hollow", "BLOCK_HOLLOW"]]) {
      this.cursorStyles[this.M.enumv("GhosttyRenderStateCursorVisualStyle", m)] = n;
    }
  }
  ptr;
  iter;
  cells;
  ex;
  mem;
  M;
  D;
  RD;
  CD;
  cursorStyles = [];
  inRow = false;
  get(data, out) {
    return this.ex.ghostty_render_state_get(this.ptr, this.D(data), out);
  }
  update(term) {
    this.vt.check(this.ex.ghostty_render_state_update(this.ptr, term.ptr), "render_state_update");
  }
  dirty() {
    const p = this.mem.scratch(4);
    this.vt.check(this.get("DIRTY", p), "get DIRTY");
    return this.mem.i32(p);
  }
  cols() {
    const p = this.mem.scratch(4);
    this.mem.setU32(p, 0);
    this.vt.check(this.get("COLS", p), "get COLS");
    return this.mem.u16(p);
  }
  rows() {
    const p = this.mem.scratch(4);
    this.mem.setU32(p, 0);
    this.vt.check(this.get("ROWS", p), "get ROWS");
    return this.mem.u16(p);
  }
  colors() {
    const S = "GhosttyRenderStateColors";
    const p = this.mem.newSized(S);
    try {
      this.vt.check(this.get("COLORS", p), "get COLORS");
      const f = (n) => p + this.M.field(S, n).offset;
      return { bg: this.mem.rgb(f("background")), fg: this.mem.rgb(f("foreground")), cursor: this.mem.rgb(f("cursor")), cursorHasValue: this.mem.bool(f("cursor_has_value")), palette: this.mem.readBytes(f("palette"), 768) };
    } finally {
      this.mem.free(p, this.M.size(S));
    }
  }
  cursor() {
    const S = "GhosttyRenderStateCursor";
    const p = this.mem.newSized(S);
    try {
      this.vt.check(this.get("CURSOR", p), "get CURSOR");
      const f = (n) => p + this.M.field(S, n).offset;
      return {
        hasValue: this.mem.bool(f("viewport_has_value")),
        x: this.mem.u16(f("viewport_x")),
        y: this.mem.u16(f("viewport_y")),
        wideTail: this.mem.bool(f("wide_tail")),
        visible: this.mem.bool(f("visible")),
        blinking: this.mem.bool(f("blinking")),
        passwordInput: this.mem.bool(f("password_input")),
        style: this.cursorStyles[this.mem.i32(f("visual_style"))] ?? "block"
      };
    } finally {
      this.mem.free(p, this.M.size(S));
    }
  }
  bindIterator() {
    const slot = this.mem.allocOpaque();
    this.mem.setU32(slot, this.iter);
    const r = this.get("ROW_ITERATOR", slot);
    if (r !== 0) {
      this.mem.freeOpaque(slot);
      this.vt.check(r, "get ROW_ITERATOR");
    }
    return slot;
  }
  /** Iterate dirty rows (all rows when dirty() is FULL). Row accessors below are valid inside fn only. */
  forEachDirtyRow(fn) {
    const slot = this.bindIterator();
    try {
      const yp = this.mem.scratch(4);
      this.inRow = true;
      while (this.ex.ghostty_render_state_row_iterator_next_dirty(this.iter, yp)) fn(this.mem.u16(yp));
    } finally {
      this.inRow = false;
      this.mem.freeOpaque(slot);
    }
  }
  /** Iterate every viewport row. */
  forEachRow(fn) {
    const slot = this.bindIterator();
    try {
      this.inRow = true;
      let y = 0;
      while (this.ex.ghostty_render_state_row_iterator_next(this.iter)) fn(y++);
    } finally {
      this.inRow = false;
      this.mem.freeOpaque(slot);
    }
  }
  rowGet(data, out) {
    if (!this.inRow) throw new Error("row accessor used outside forEachDirtyRow/forEachRow");
    return this.ex.ghostty_render_state_row_get(this.iter, this.RD(data), out);
  }
  /** Copy of the row's packed cells: 2 u32 (lo, hi) per column. */
  rowCells() {
    const S = "GhosttyCellsView";
    const p = this.mem.scratch(this.M.size(S));
    this.vt.check(this.rowGet("CELLS_RAW", p), "row CELLS_RAW");
    const ptr = this.mem.u32(p + this.M.field(S, "ptr").offset), len = this.mem.u32(p + this.M.field(S, "len").offset);
    return new Uint32Array(this.mem.readBytes(ptr, len * 8).buffer);
  }
  rowSelection() {
    const S = "GhosttyRenderStateRowSelection";
    const size = this.M.size(S);
    const p = this.mem.scratch(size);
    this.mem.zero(p, size);
    this.mem.setU32(p, size);
    const r = this.rowGet("SELECTION", p);
    if (r === this.vt.result("NO_VALUE")) return null;
    this.vt.check(r, "row SELECTION");
    return { startX: this.mem.u16(p + this.M.field(S, "start_x").offset), endX: this.mem.u16(p + this.M.field(S, "end_x").offset) };
  }
  selectCell(x) {
    const slot = this.mem.scratch(4);
    this.mem.setU32(slot, this.cells);
    this.vt.check(this.rowGet("CELLS", slot), "row CELLS");
    this.vt.check(this.ex.ghostty_render_state_row_cells_select(this.cells, x), "row_cells_select");
  }
  readStyleColor(p) {
    const S = "GhosttyStyleColor";
    const tag = this.mem.i32(p + this.M.field(S, "tag").offset);
    const value = this.M.field(S, "value");
    if (tag === this.M.enumv("GhosttyStyleColorTag", "RGB")) return this.mem.rgb(p + value.offset + this.M.field(value.type, "rgb").offset);
    return null;
  }
  cellStyle(x) {
    this.selectCell(x);
    const S = "GhosttyStyle";
    const p = this.mem.newSized(S);
    try {
      this.vt.check(this.ex.ghostty_render_state_row_cells_get(this.cells, this.CD("STYLE"), p), "cells STYLE");
      const f = (n) => p + this.M.field(S, n).offset;
      const b = (n) => this.mem.bool(f(n));
      return {
        fg: this.readStyleColor(f("fg_color")),
        bg: this.readStyleColor(f("bg_color")),
        bold: b("bold"),
        italic: b("italic"),
        faint: b("faint"),
        blink: b("blink"),
        inverse: b("inverse"),
        invisible: b("invisible"),
        strikethrough: b("strikethrough"),
        underline: this.mem.i32(f("underline"))
      };
    } finally {
      this.mem.free(p, this.M.size(S));
    }
  }
  /** Foreground/background resolved by the library (palette applied); null = use terminal defaults. */
  cellFgBg(x) {
    this.selectCell(x);
    const p = this.mem.scratch(8);
    const fg = this.ex.ghostty_render_state_row_cells_get(this.cells, this.CD("FG_COLOR"), p) === 0 ? this.mem.rgb(p) : null;
    const bg = this.ex.ghostty_render_state_row_cells_get(this.cells, this.CD("BG_COLOR"), p + 4) === 0 ? this.mem.rgb(p + 4) : null;
    return { fg, bg };
  }
  cellGrapheme(x) {
    this.selectCell(x);
    const S = "GhosttyBuffer";
    const size = this.M.size(S);
    let cap = 64;
    for (; ; ) {
      const p = this.mem.scratch(size + cap);
      const buf = p + size;
      this.mem.setU32(p + this.M.field(S, "ptr").offset, buf);
      this.mem.setU32(p + this.M.field(S, "cap").offset, cap);
      this.mem.setU32(p + this.M.field(S, "len").offset, 0);
      const r = this.ex.ghostty_render_state_row_cells_get(this.cells, this.CD("GRAPHEMES_UTF8"), p);
      const len = this.mem.u32(p + this.M.field(S, "len").offset);
      if (r === 0) return len ? this.mem.readString(buf, len) : "";
      if (r === this.vt.result("OUT_OF_SPACE") && len > cap) {
        cap = len;
        continue;
      }
      this.vt.check(r, "cells GRAPHEMES_UTF8");
      return "";
    }
  }
  clean() {
    this.vt.check(this.ex.ghostty_render_state_clean(this.ptr), "render_state_clean");
  }
  free() {
    if (this.cells) {
      this.ex.ghostty_render_state_row_cells_free(this.cells);
      this.cells = 0;
    }
    if (this.iter) {
      this.ex.ghostty_render_state_row_iterator_free(this.iter);
      this.iter = 0;
    }
    if (this.ptr) {
      this.ex.ghostty_render_state_free(this.ptr);
      this.ptr = 0;
    }
  }
}
class SelectionGesture {
  constructor(term) {
    this.term = term;
    const vt = term.vt;
    this.ex = vt.ex;
    this.mem = vt.mem;
    this.M = vt.manifest;
    this.ptr = vt.handle("selection_gesture_new", (s) => this.ex.ghostty_selection_gesture_new(0, s));
    for (const type of ["PRESS", "DRAG", "RELEASE"]) {
      const v = this.M.enumv("GhosttySelectionGestureEventType", type);
      this.events[type] = vt.handle(`gesture_event_new ${type}`, (s) => this.ex.ghostty_selection_gesture_event_new(0, s, v));
    }
    const interval = this.mem.scratch(16);
    this.mem.setU64(interval, 5e8);
    this.opt(this.events.PRESS, "REPEAT_INTERVAL_NS", interval);
    this.mem.setF64(interval + 8, 4);
    this.opt(this.events.PRESS, "REPEAT_DISTANCE", interval + 8);
  }
  ptr;
  events = {};
  ex;
  mem;
  M;
  opt(ev, name, valuePtr) {
    this.term.vt.check(this.ex.ghostty_selection_gesture_event_set(ev, this.M.enumv("GhosttySelectionGestureEventOption", name), valuePtr), `gesture opt ${name}`);
  }
  setRef(ev, x, y) {
    const ref = this.term.gridRefViewport(x, y);
    try {
      this.opt(ev, "REF", ref);
    } finally {
      this.term.freeGridRef(ref);
    }
  }
  setPosition(ev, xPx, yPx) {
    const S = "GhosttySurfacePosition";
    const p = this.mem.scratch(this.M.size(S));
    this.term.vt.setField(p, S, "x", xPx);
    this.term.vt.setField(p, S, "y", yPx);
    this.opt(ev, "POSITION", p);
  }
  /** Fire the event and apply the resulting selection (or clear it). Returns true when a selection exists. */
  fire(ev) {
    const S = "GhosttySelection";
    const sel = this.mem.newSized(S);
    try {
      const r = this.ex.ghostty_selection_gesture_event(this.ptr, this.term.ptr, ev, sel);
      if (r === this.term.vt.result("NO_VALUE")) {
        this.term.clearSelection();
        return false;
      }
      this.term.vt.check(r, "selection_gesture_event");
      this.term.vt.check(this.ex.ghostty_terminal_set(this.term.ptr, this.M.enumv("GhosttyTerminalOption", "SELECTION"), sel), "set SELECTION");
      return true;
    } finally {
      this.mem.free(sel, this.M.size(S));
    }
  }
  press(x, y, xPx, yPx, timeNs) {
    const ev = this.events.PRESS;
    this.setRef(ev, x, y);
    this.setPosition(ev, xPx, yPx);
    const t = this.mem.scratch(8);
    this.mem.setU64(t, timeNs);
    this.opt(ev, "TIME_NS", t);
    return this.fire(ev);
  }
  drag(x, y, xPx, yPx, geo) {
    const ev = this.events.DRAG;
    const G = "GhosttySelectionGestureGeometry";
    this.setRef(ev, x, y);
    this.setPosition(ev, xPx, yPx);
    const g = this.mem.scratch(this.M.size(G));
    this.term.vt.setField(g, G, "columns", geo.columns);
    this.term.vt.setField(g, G, "cell_width", geo.cellWidth);
    this.term.vt.setField(g, G, "padding_left", geo.paddingLeft);
    this.term.vt.setField(g, G, "screen_height", geo.screenHeight);
    this.opt(ev, "GEOMETRY", g);
    return this.fire(ev);
  }
  release(x, y = 0) {
    const ev = this.events.RELEASE;
    if (x !== null) this.setRef(ev, x, y);
    this.ex.ghostty_selection_gesture_event(this.ptr, this.term.ptr, ev, 0);
  }
  reset() {
    this.ex.ghostty_selection_gesture_reset(this.ptr, this.term.ptr);
  }
  free() {
    for (const ev of Object.values(this.events)) this.ex.ghostty_selection_gesture_event_free(ev);
    this.events = {};
    if (this.ptr) {
      this.ex.ghostty_selection_gesture_free(this.ptr, this.term.ptr);
      this.ptr = 0;
    }
  }
}
class MouseEncoder {
  constructor(vt) {
    this.vt = vt;
    this.ex = vt.ex;
    this.mem = vt.mem;
    this.M = vt.manifest;
    this.ptr = vt.handle("mouse_encoder_new", (s) => this.ex.ghostty_mouse_encoder_new(0, s));
    this.ev = vt.handle("mouse_event_new", (s) => this.ex.ghostty_mouse_event_new(0, s));
  }
  ptr;
  ev;
  ex;
  mem;
  M;
  opt(name, valuePtr) {
    this.ex.ghostty_mouse_encoder_setopt(this.ptr, this.M.enumv("GhosttyMouseEncoderOption", name), valuePtr);
  }
  /** Copy the tracking mode and report format from the terminal's current state. */
  syncFromTerminal(term) {
    this.ex.ghostty_mouse_encoder_setopt_from_terminal(this.ptr, term.ptr);
  }
  setSize(cols, rows, cellWidth, cellHeight) {
    const S = "GhosttyMouseEncoderSize";
    const size = this.M.size(S);
    const p = this.mem.scratch(size);
    this.mem.zero(p, size);
    this.vt.setField(p, S, "size", size);
    this.vt.setField(p, S, "screen_width", cols * cellWidth);
    this.vt.setField(p, S, "screen_height", rows * cellHeight);
    this.vt.setField(p, S, "cell_width", cellWidth);
    this.vt.setField(p, S, "cell_height", cellHeight);
    this.opt("SIZE", p);
  }
  /** Button-event tracking reports motion only while a button is held. */
  setAnyButtonPressed(pressed) {
    const p = this.mem.scratch(4);
    this.mem.setU8(p, pressed ? 1 : 0);
    this.opt("ANY_BUTTON_PRESSED", p);
  }
  /** The bytes to send for this event, empty if the application doesn't want it. */
  encode(input) {
    const ex = this.ex, M = this.M, ev = this.ev;
    ex.ghostty_mouse_event_set_action(ev, M.enumv("GhosttyMouseAction", input.action));
    if (input.button) ex.ghostty_mouse_event_set_button(ev, M.enumv("GhosttyMouseButton", input.button));
    else ex.ghostty_mouse_event_clear_button(ev);
    ex.ghostty_mouse_event_set_mods(ev, input.mods);
    const P = "GhosttyMousePosition";
    const p = this.mem.scratch(M.size(P));
    this.vt.setField(p, P, "x", input.x);
    this.vt.setField(p, P, "y", input.y);
    ex.ghostty_mouse_event_set_position(ev, p);
    const cap = 64;
    const buf = this.mem.alloc(cap + 4);
    try {
      if (ex.ghostty_mouse_encoder_encode(this.ptr, ev, buf, cap, buf + cap) !== 0) return new Uint8Array(0);
      return this.mem.readBytes(buf, this.mem.u32(buf + cap));
    } finally {
      this.mem.free(buf, cap + 4);
    }
  }
  dispose() {
    if (this.ev) {
      this.ex.ghostty_mouse_event_free(this.ev);
      this.ev = 0;
    }
    if (this.ptr) {
      this.ex.ghostty_mouse_encoder_free(this.ptr);
      this.ptr = 0;
    }
  }
}
class KeyEncoder {
  constructor(vt) {
    this.vt = vt;
    this.ex = vt.ex;
    this.mem = vt.mem;
    this.ptr = vt.handle("key_encoder_new", (s) => this.ex.ghostty_key_encoder_new(0, s));
  }
  ptr;
  ex;
  mem;
  setOption(option, value) {
    const p = this.mem.scratch(4);
    this.mem.setU8(p, typeof value === "boolean" ? value ? 1 : 0 : value);
    this.ex.ghostty_key_encoder_setopt(this.ptr, option, p);
  }
  /** Copy cursor-key mode, keypad mode, kitty flags… from the terminal's current state. */
  syncFromTerminal(term) {
    this.ex.ghostty_key_encoder_setopt_from_terminal(this.ptr, term.ptr);
  }
  encode(event) {
    const ev = this.vt.handle("key_event_new", (s) => this.ex.ghostty_key_event_new(0, s));
    let up = 0, utf8 = null;
    try {
      this.ex.ghostty_key_event_set_action(ev, event.action);
      this.ex.ghostty_key_event_set_key(ev, event.key);
      this.ex.ghostty_key_event_set_mods(ev, event.mods);
      if (event.consumedMods !== void 0) this.ex.ghostty_key_event_set_consumed_mods(ev, event.consumedMods);
      if (event.composing !== void 0) this.ex.ghostty_key_event_set_composing(ev, event.composing ? 1 : 0);
      if (event.unshiftedCodepoint !== void 0) this.ex.ghostty_key_event_set_unshifted_codepoint(ev, event.unshiftedCodepoint);
      if (event.utf8) {
        utf8 = this.mem.encode(event.utf8);
        if (utf8.length) {
          up = this.mem.alloc(utf8.length);
          this.mem.writeBytes(up, utf8);
          this.ex.ghostty_key_event_set_utf8(ev, up, utf8.length);
        }
      }
      const cap = 64;
      const buf = this.mem.alloc(cap + 4);
      const lenPtr = buf + cap;
      try {
        const r = this.ex.ghostty_key_encoder_encode(this.ptr, ev, buf, cap, lenPtr);
        if (r !== 0) return new Uint8Array(0);
        return this.mem.readBytes(buf, this.mem.u32(lenPtr));
      } finally {
        this.mem.free(buf, cap + 4);
      }
    } finally {
      if (up && utf8) this.mem.free(up, utf8.length);
      this.ex.ghostty_key_event_free(ev);
    }
  }
  dispose() {
    if (this.ptr) {
      this.ex.ghostty_key_encoder_free(this.ptr);
      this.ptr = 0;
    }
  }
}
var Key = /* @__PURE__ */ ((Key2) => {
  Key2[Key2["UNIDENTIFIED"] = 0] = "UNIDENTIFIED";
  Key2[Key2["BACKQUOTE"] = 1] = "BACKQUOTE";
  Key2[Key2["BACKSLASH"] = 2] = "BACKSLASH";
  Key2[Key2["BRACKET_LEFT"] = 3] = "BRACKET_LEFT";
  Key2[Key2["BRACKET_RIGHT"] = 4] = "BRACKET_RIGHT";
  Key2[Key2["COMMA"] = 5] = "COMMA";
  Key2[Key2["DIGIT_0"] = 6] = "DIGIT_0";
  Key2[Key2["DIGIT_1"] = 7] = "DIGIT_1";
  Key2[Key2["DIGIT_2"] = 8] = "DIGIT_2";
  Key2[Key2["DIGIT_3"] = 9] = "DIGIT_3";
  Key2[Key2["DIGIT_4"] = 10] = "DIGIT_4";
  Key2[Key2["DIGIT_5"] = 11] = "DIGIT_5";
  Key2[Key2["DIGIT_6"] = 12] = "DIGIT_6";
  Key2[Key2["DIGIT_7"] = 13] = "DIGIT_7";
  Key2[Key2["DIGIT_8"] = 14] = "DIGIT_8";
  Key2[Key2["DIGIT_9"] = 15] = "DIGIT_9";
  Key2[Key2["EQUAL"] = 16] = "EQUAL";
  Key2[Key2["INTL_BACKSLASH"] = 17] = "INTL_BACKSLASH";
  Key2[Key2["INTL_RO"] = 18] = "INTL_RO";
  Key2[Key2["INTL_YEN"] = 19] = "INTL_YEN";
  Key2[Key2["A"] = 20] = "A";
  Key2[Key2["B"] = 21] = "B";
  Key2[Key2["C"] = 22] = "C";
  Key2[Key2["D"] = 23] = "D";
  Key2[Key2["E"] = 24] = "E";
  Key2[Key2["F"] = 25] = "F";
  Key2[Key2["G"] = 26] = "G";
  Key2[Key2["H"] = 27] = "H";
  Key2[Key2["I"] = 28] = "I";
  Key2[Key2["J"] = 29] = "J";
  Key2[Key2["K"] = 30] = "K";
  Key2[Key2["L"] = 31] = "L";
  Key2[Key2["M"] = 32] = "M";
  Key2[Key2["N"] = 33] = "N";
  Key2[Key2["O"] = 34] = "O";
  Key2[Key2["P"] = 35] = "P";
  Key2[Key2["Q"] = 36] = "Q";
  Key2[Key2["R"] = 37] = "R";
  Key2[Key2["S"] = 38] = "S";
  Key2[Key2["T"] = 39] = "T";
  Key2[Key2["U"] = 40] = "U";
  Key2[Key2["V"] = 41] = "V";
  Key2[Key2["W"] = 42] = "W";
  Key2[Key2["X"] = 43] = "X";
  Key2[Key2["Y"] = 44] = "Y";
  Key2[Key2["Z"] = 45] = "Z";
  Key2[Key2["MINUS"] = 46] = "MINUS";
  Key2[Key2["PERIOD"] = 47] = "PERIOD";
  Key2[Key2["QUOTE"] = 48] = "QUOTE";
  Key2[Key2["SEMICOLON"] = 49] = "SEMICOLON";
  Key2[Key2["SLASH"] = 50] = "SLASH";
  Key2[Key2["ALT_LEFT"] = 51] = "ALT_LEFT";
  Key2[Key2["ALT_RIGHT"] = 52] = "ALT_RIGHT";
  Key2[Key2["BACKSPACE"] = 53] = "BACKSPACE";
  Key2[Key2["CAPS_LOCK"] = 54] = "CAPS_LOCK";
  Key2[Key2["CONTEXT_MENU"] = 55] = "CONTEXT_MENU";
  Key2[Key2["CONTROL_LEFT"] = 56] = "CONTROL_LEFT";
  Key2[Key2["CONTROL_RIGHT"] = 57] = "CONTROL_RIGHT";
  Key2[Key2["ENTER"] = 58] = "ENTER";
  Key2[Key2["META_LEFT"] = 59] = "META_LEFT";
  Key2[Key2["META_RIGHT"] = 60] = "META_RIGHT";
  Key2[Key2["SHIFT_LEFT"] = 61] = "SHIFT_LEFT";
  Key2[Key2["SHIFT_RIGHT"] = 62] = "SHIFT_RIGHT";
  Key2[Key2["SPACE"] = 63] = "SPACE";
  Key2[Key2["TAB"] = 64] = "TAB";
  Key2[Key2["CONVERT"] = 65] = "CONVERT";
  Key2[Key2["KANA_MODE"] = 66] = "KANA_MODE";
  Key2[Key2["NON_CONVERT"] = 67] = "NON_CONVERT";
  Key2[Key2["DELETE"] = 68] = "DELETE";
  Key2[Key2["END"] = 69] = "END";
  Key2[Key2["HELP"] = 70] = "HELP";
  Key2[Key2["HOME"] = 71] = "HOME";
  Key2[Key2["INSERT"] = 72] = "INSERT";
  Key2[Key2["PAGE_DOWN"] = 73] = "PAGE_DOWN";
  Key2[Key2["PAGE_UP"] = 74] = "PAGE_UP";
  Key2[Key2["ARROW_DOWN"] = 75] = "ARROW_DOWN";
  Key2[Key2["ARROW_LEFT"] = 76] = "ARROW_LEFT";
  Key2[Key2["ARROW_RIGHT"] = 77] = "ARROW_RIGHT";
  Key2[Key2["ARROW_UP"] = 78] = "ARROW_UP";
  Key2[Key2["NUM_LOCK"] = 79] = "NUM_LOCK";
  Key2[Key2["NUMPAD_0"] = 80] = "NUMPAD_0";
  Key2[Key2["NUMPAD_1"] = 81] = "NUMPAD_1";
  Key2[Key2["NUMPAD_2"] = 82] = "NUMPAD_2";
  Key2[Key2["NUMPAD_3"] = 83] = "NUMPAD_3";
  Key2[Key2["NUMPAD_4"] = 84] = "NUMPAD_4";
  Key2[Key2["NUMPAD_5"] = 85] = "NUMPAD_5";
  Key2[Key2["NUMPAD_6"] = 86] = "NUMPAD_6";
  Key2[Key2["NUMPAD_7"] = 87] = "NUMPAD_7";
  Key2[Key2["NUMPAD_8"] = 88] = "NUMPAD_8";
  Key2[Key2["NUMPAD_9"] = 89] = "NUMPAD_9";
  Key2[Key2["NUMPAD_ADD"] = 90] = "NUMPAD_ADD";
  Key2[Key2["NUMPAD_BACKSPACE"] = 91] = "NUMPAD_BACKSPACE";
  Key2[Key2["NUMPAD_CLEAR"] = 92] = "NUMPAD_CLEAR";
  Key2[Key2["NUMPAD_CLEAR_ENTRY"] = 93] = "NUMPAD_CLEAR_ENTRY";
  Key2[Key2["NUMPAD_COMMA"] = 94] = "NUMPAD_COMMA";
  Key2[Key2["NUMPAD_DECIMAL"] = 95] = "NUMPAD_DECIMAL";
  Key2[Key2["NUMPAD_DIVIDE"] = 96] = "NUMPAD_DIVIDE";
  Key2[Key2["NUMPAD_ENTER"] = 97] = "NUMPAD_ENTER";
  Key2[Key2["NUMPAD_EQUAL"] = 98] = "NUMPAD_EQUAL";
  Key2[Key2["NUMPAD_MEMORY_ADD"] = 99] = "NUMPAD_MEMORY_ADD";
  Key2[Key2["NUMPAD_MEMORY_CLEAR"] = 100] = "NUMPAD_MEMORY_CLEAR";
  Key2[Key2["NUMPAD_MEMORY_RECALL"] = 101] = "NUMPAD_MEMORY_RECALL";
  Key2[Key2["NUMPAD_MEMORY_STORE"] = 102] = "NUMPAD_MEMORY_STORE";
  Key2[Key2["NUMPAD_MEMORY_SUBTRACT"] = 103] = "NUMPAD_MEMORY_SUBTRACT";
  Key2[Key2["NUMPAD_MULTIPLY"] = 104] = "NUMPAD_MULTIPLY";
  Key2[Key2["NUMPAD_PAREN_LEFT"] = 105] = "NUMPAD_PAREN_LEFT";
  Key2[Key2["NUMPAD_PAREN_RIGHT"] = 106] = "NUMPAD_PAREN_RIGHT";
  Key2[Key2["NUMPAD_SUBTRACT"] = 107] = "NUMPAD_SUBTRACT";
  Key2[Key2["NUMPAD_SEPARATOR"] = 108] = "NUMPAD_SEPARATOR";
  Key2[Key2["NUMPAD_UP"] = 109] = "NUMPAD_UP";
  Key2[Key2["NUMPAD_DOWN"] = 110] = "NUMPAD_DOWN";
  Key2[Key2["NUMPAD_RIGHT"] = 111] = "NUMPAD_RIGHT";
  Key2[Key2["NUMPAD_LEFT"] = 112] = "NUMPAD_LEFT";
  Key2[Key2["NUMPAD_BEGIN"] = 113] = "NUMPAD_BEGIN";
  Key2[Key2["NUMPAD_HOME"] = 114] = "NUMPAD_HOME";
  Key2[Key2["NUMPAD_END"] = 115] = "NUMPAD_END";
  Key2[Key2["NUMPAD_INSERT"] = 116] = "NUMPAD_INSERT";
  Key2[Key2["NUMPAD_DELETE"] = 117] = "NUMPAD_DELETE";
  Key2[Key2["NUMPAD_PAGE_UP"] = 118] = "NUMPAD_PAGE_UP";
  Key2[Key2["NUMPAD_PAGE_DOWN"] = 119] = "NUMPAD_PAGE_DOWN";
  Key2[Key2["ESCAPE"] = 120] = "ESCAPE";
  Key2[Key2["F1"] = 121] = "F1";
  Key2[Key2["F2"] = 122] = "F2";
  Key2[Key2["F3"] = 123] = "F3";
  Key2[Key2["F4"] = 124] = "F4";
  Key2[Key2["F5"] = 125] = "F5";
  Key2[Key2["F6"] = 126] = "F6";
  Key2[Key2["F7"] = 127] = "F7";
  Key2[Key2["F8"] = 128] = "F8";
  Key2[Key2["F9"] = 129] = "F9";
  Key2[Key2["F10"] = 130] = "F10";
  Key2[Key2["F11"] = 131] = "F11";
  Key2[Key2["F12"] = 132] = "F12";
  Key2[Key2["F13"] = 133] = "F13";
  Key2[Key2["F14"] = 134] = "F14";
  Key2[Key2["F15"] = 135] = "F15";
  Key2[Key2["F16"] = 136] = "F16";
  Key2[Key2["F17"] = 137] = "F17";
  Key2[Key2["F18"] = 138] = "F18";
  Key2[Key2["F19"] = 139] = "F19";
  Key2[Key2["F20"] = 140] = "F20";
  Key2[Key2["F21"] = 141] = "F21";
  Key2[Key2["F22"] = 142] = "F22";
  Key2[Key2["F23"] = 143] = "F23";
  Key2[Key2["F24"] = 144] = "F24";
  Key2[Key2["F25"] = 145] = "F25";
  Key2[Key2["FN"] = 146] = "FN";
  Key2[Key2["FN_LOCK"] = 147] = "FN_LOCK";
  Key2[Key2["PRINT_SCREEN"] = 148] = "PRINT_SCREEN";
  Key2[Key2["SCROLL_LOCK"] = 149] = "SCROLL_LOCK";
  Key2[Key2["PAUSE"] = 150] = "PAUSE";
  Key2[Key2["BROWSER_BACK"] = 151] = "BROWSER_BACK";
  Key2[Key2["BROWSER_FAVORITES"] = 152] = "BROWSER_FAVORITES";
  Key2[Key2["BROWSER_FORWARD"] = 153] = "BROWSER_FORWARD";
  Key2[Key2["BROWSER_HOME"] = 154] = "BROWSER_HOME";
  Key2[Key2["BROWSER_REFRESH"] = 155] = "BROWSER_REFRESH";
  Key2[Key2["BROWSER_SEARCH"] = 156] = "BROWSER_SEARCH";
  Key2[Key2["BROWSER_STOP"] = 157] = "BROWSER_STOP";
  Key2[Key2["EJECT"] = 158] = "EJECT";
  Key2[Key2["LAUNCH_APP_1"] = 159] = "LAUNCH_APP_1";
  Key2[Key2["LAUNCH_APP_2"] = 160] = "LAUNCH_APP_2";
  Key2[Key2["LAUNCH_MAIL"] = 161] = "LAUNCH_MAIL";
  Key2[Key2["MEDIA_PLAY_PAUSE"] = 162] = "MEDIA_PLAY_PAUSE";
  Key2[Key2["MEDIA_SELECT"] = 163] = "MEDIA_SELECT";
  Key2[Key2["MEDIA_STOP"] = 164] = "MEDIA_STOP";
  Key2[Key2["MEDIA_TRACK_NEXT"] = 165] = "MEDIA_TRACK_NEXT";
  Key2[Key2["MEDIA_TRACK_PREVIOUS"] = 166] = "MEDIA_TRACK_PREVIOUS";
  Key2[Key2["POWER"] = 167] = "POWER";
  Key2[Key2["SLEEP"] = 168] = "SLEEP";
  Key2[Key2["AUDIO_VOLUME_DOWN"] = 169] = "AUDIO_VOLUME_DOWN";
  Key2[Key2["AUDIO_VOLUME_MUTE"] = 170] = "AUDIO_VOLUME_MUTE";
  Key2[Key2["AUDIO_VOLUME_UP"] = 171] = "AUDIO_VOLUME_UP";
  Key2[Key2["WAKE_UP"] = 172] = "WAKE_UP";
  Key2[Key2["COPY"] = 173] = "COPY";
  Key2[Key2["CUT"] = 174] = "CUT";
  Key2[Key2["PASTE"] = 175] = "PASTE";
  return Key2;
})(Key || {});
var KeyAction = /* @__PURE__ */ ((KeyAction2) => {
  KeyAction2[KeyAction2["RELEASE"] = 0] = "RELEASE";
  KeyAction2[KeyAction2["PRESS"] = 1] = "PRESS";
  KeyAction2[KeyAction2["REPEAT"] = 2] = "REPEAT";
  return KeyAction2;
})(KeyAction || {});
var KeyEncoderOption = /* @__PURE__ */ ((KeyEncoderOption2) => {
  KeyEncoderOption2[KeyEncoderOption2["CURSOR_KEY_APPLICATION"] = 0] = "CURSOR_KEY_APPLICATION";
  KeyEncoderOption2[KeyEncoderOption2["KEYPAD_KEY_APPLICATION"] = 1] = "KEYPAD_KEY_APPLICATION";
  KeyEncoderOption2[KeyEncoderOption2["IGNORE_KEYPAD_WITH_NUMLOCK"] = 2] = "IGNORE_KEYPAD_WITH_NUMLOCK";
  KeyEncoderOption2[KeyEncoderOption2["ALT_ESC_PREFIX"] = 3] = "ALT_ESC_PREFIX";
  KeyEncoderOption2[KeyEncoderOption2["MODIFY_OTHER_KEYS_STATE_2"] = 4] = "MODIFY_OTHER_KEYS_STATE_2";
  KeyEncoderOption2[KeyEncoderOption2["KITTY_FLAGS"] = 5] = "KITTY_FLAGS";
  KeyEncoderOption2[KeyEncoderOption2["MACOS_OPTION_AS_ALT"] = 6] = "MACOS_OPTION_AS_ALT";
  KeyEncoderOption2[KeyEncoderOption2["BACKARROW_KEY_MODE"] = 7] = "BACKARROW_KEY_MODE";
  return KeyEncoderOption2;
})(KeyEncoderOption || {});
var Mods = /* @__PURE__ */ ((Mods2) => {
  Mods2[Mods2["NONE"] = 0] = "NONE";
  Mods2[Mods2["SHIFT"] = 1] = "SHIFT";
  Mods2[Mods2["CTRL"] = 2] = "CTRL";
  Mods2[Mods2["ALT"] = 4] = "ALT";
  Mods2[Mods2["SUPER"] = 8] = "SUPER";
  Mods2[Mods2["CAPSLOCK"] = 16] = "CAPSLOCK";
  Mods2[Mods2["NUMLOCK"] = 32] = "NUMLOCK";
  return Mods2;
})(Mods || {});
const DEFAULT_THEME = {
  foreground: "#e6e6e6",
  background: "#0b0f16",
  cursor: "#e6e6e6",
  cursorAccent: "#0b0f16",
  selectionBackground: "#3a4a63",
  selectionForeground: "#ffffff",
  black: "#000000",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec"
};
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function parseTheme(t = {}) {
  const th = { ...DEFAULT_THEME, ...t };
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  const palette256 = names.map((n) => hexToRgb(th[n]));
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) palette256.push([steps[r], steps[g], steps[b]]);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette256.push([v, v, v]);
  }
  return { fg: hexToRgb(th.foreground), bg: hexToRgb(th.background), cursor: hexToRgb(th.cursor), cursorAccent: hexToRgb(th.cursorAccent), selBg: hexToRgb(th.selectionBackground), selFg: hexToRgb(th.selectionForeground), palette256 };
}
const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const sameRgb = (a, b) => a === b || !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function buildSpans(rs, dec, colors, sel, theme, cells) {
  const spans = [];
  const styleCache = /* @__PURE__ */ new Map();
  const paletteRgb = (i) => [colors.palette[i * 3], colors.palette[i * 3 + 1], colors.palette[i * 3 + 2]];
  let cur = null;
  const ncols = cells.length >> 1;
  for (let x = 0; x < ncols; x++) {
    const lo = cells[x * 2], hi = cells[x * 2 + 1];
    const wide = dec.wide(lo, hi);
    if (wide === dec.WIDE_SPACER_TAIL || wide === dec.WIDE_SPACER_HEAD) continue;
    const tag = dec.tag(lo, hi);
    const styleId = dec.styleId(lo, hi);
    let style = null;
    if (styleId !== 0) {
      style = styleCache.get(styleId) ?? null;
      if (!style) {
        style = rs.cellStyle(x);
        styleCache.set(styleId, style);
      }
    }
    let text = " ";
    if (tag === dec.TAG_GRAPHEME) text = rs.cellGrapheme(x) || " ";
    else if (tag === dec.TAG_CODEPOINT) {
      const cp = dec.codepoint(lo, hi);
      if (cp) text = String.fromCodePoint(cp);
    }
    let fg = colors.fg, bg = null;
    if (tag === dec.TAG_BG_PALETTE) bg = paletteRgb(dec.paletteIndex(lo, hi));
    else if (tag === dec.TAG_BG_RGB) bg = dec.rgb(lo, hi);
    if (style) {
      if (style.fg && style.bg) {
        fg = style.fg;
        bg = style.bg;
      } else {
        const c = rs.cellFgBg(x);
        if (c.fg) fg = c.fg;
        if (c.bg) bg = c.bg;
      }
      if (style.inverse) {
        const t = fg;
        fg = bg ?? colors.bg;
        bg = t;
      }
    }
    if (sel && x >= sel.startX && x <= sel.endX) {
      fg = theme.selFg;
      bg = theme.selBg;
    }
    const bold = !!style?.bold, italic = !!style?.italic, faint = !!style?.faint, underline = (style?.underline ?? 0) > 0, strike = !!style?.strikethrough, invisible = !!style?.invisible;
    const w = wide === dec.WIDE_WIDE ? 2 : 1;
    if (cur && w === 1 && cur.x + cur.width === x && sameRgb(cur.fg, fg) && sameRgb(cur.bg, bg) && cur.bold === bold && cur.italic === italic && cur.faint === faint && cur.underline === underline && cur.strike === strike && cur.invisible === invisible) {
      cur.text += text;
      cur.width += 1;
    } else {
      cur = { x, width: w, text, fg, bg, bold, italic, faint, underline, strike, invisible };
      spans.push(cur);
      if (w === 2) cur = null;
    }
  }
  return spans;
}
class CanvasRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.fontSize = opts.fontSize ?? 15;
    this.fontFamily = opts.fontFamily ?? "monospace";
    this.cursorStyleOpt = opts.cursorStyle ?? "block";
    this.cursorBlink = opts.cursorBlink ?? false;
    this.theme = parseTheme(opts.theme);
    this.devicePixelRatio = opts.devicePixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1) ?? 1;
    this.metrics = this.measureFont();
    if (this.cursorBlink) this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.needCursorRepaint = true;
    }, 530);
  }
  metrics;
  devicePixelRatio;
  ctx;
  fontSize;
  fontFamily;
  cursorStyleOpt;
  cursorBlink;
  theme;
  dec = null;
  cols = 0;
  rows = 0;
  lastCursor = null;
  blinkOn = true;
  blinkTimer = null;
  needCursorRepaint = false;
  get resolvedTheme() {
    return this.theme;
  }
  getMetrics() {
    return this.metrics;
  }
  measureFont() {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const m = ctx.measureText("M");
    const asc = m.actualBoundingBoxAscent || this.fontSize * 0.8, desc = m.actualBoundingBoxDescent || this.fontSize * 0.2;
    return { width: Math.ceil(m.width), height: Math.ceil(asc + desc) + 2, baseline: Math.ceil(asc) + 1 };
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    const w = cols * this.metrics.width, h = rows * this.metrics.height;
    this.canvas.width = Math.round(w * this.devicePixelRatio);
    this.canvas.height = Math.round(h * this.devicePixelRatio);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    this.ctx.fillStyle = css(this.theme.bg);
    this.ctx.fillRect(0, 0, w, h);
    this.lastCursor = null;
  }
  /** Ask for the cursor row to be repainted on the next frame (blink, focus change). */
  invalidateCursor() {
    this.needCursorRepaint = true;
  }
  /** Paint what changed since the last frame. Returns true when something was drawn. */
  render(rs, force = false) {
    if (!this.dec) this.dec = new CellDecoder(rs.vt.manifest);
    const dirty = rs.dirty();
    const cursor = rs.cursor();
    const cursorMoved = !this.lastCursor || this.lastCursor.x !== cursor.x || this.lastCursor.y !== cursor.y || this.lastCursor.visible !== cursor.visible || this.lastCursor.hasValue !== cursor.hasValue;
    if (!force && dirty === 0 && !cursorMoved && !this.needCursorRepaint) return false;
    const colors = rs.colors();
    const dec = this.dec;
    const painted = /* @__PURE__ */ new Set();
    const paintRow = (y) => {
      this.drawRow(colors, y, buildSpans(rs, dec, colors, rs.rowSelection(), this.theme, rs.rowCells()));
      painted.add(y);
    };
    if (force) {
      this.ctx.fillStyle = css(colors.bg);
      this.ctx.fillRect(0, 0, this.cols * this.metrics.width, this.rows * this.metrics.height);
      rs.forEachRow(paintRow);
    } else {
      rs.forEachDirtyRow(paintRow);
    }
    const extra = /* @__PURE__ */ new Set();
    if (this.lastCursor && this.lastCursor.hasValue && !painted.has(this.lastCursor.y)) extra.add(this.lastCursor.y);
    if (cursor.hasValue && !painted.has(cursor.y)) extra.add(cursor.y);
    if (extra.size) rs.forEachRow((y) => {
      if (extra.has(y)) paintRow(y);
    });
    if (cursor.hasValue && cursor.visible && (!this.cursorBlink || this.blinkOn || !cursor.blinking)) this.drawCursor(cursor, colors);
    this.lastCursor = cursor;
    this.needCursorRepaint = false;
    rs.clean();
    return true;
  }
  drawRow(colors, y, spans) {
    const { width: cw, height: ch, baseline } = this.metrics;
    const ctx = this.ctx;
    const top = y * ch;
    ctx.fillStyle = css(colors.bg);
    ctx.fillRect(0, top, this.cols * cw, ch);
    for (const s of spans) if (s.bg) {
      ctx.fillStyle = css(s.bg);
      ctx.fillRect(s.x * cw, top, s.width * cw, ch);
    }
    for (const s of spans) {
      if (s.invisible || s.text.trim() === "") continue;
      ctx.font = `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${this.fontSize}px ${this.fontFamily}`;
      ctx.fillStyle = css(s.fg);
      ctx.globalAlpha = s.faint ? 0.5 : 1;
      if (s.width === 2) ctx.fillText(s.text, s.x * cw, top + baseline);
      else for (let i = 0; i < s.text.length; i++) {
        if (s.text[i] !== " ") ctx.fillText(s.text[i], (s.x + i) * cw, top + baseline);
      }
      ctx.globalAlpha = 1;
      const spanW = s.width * cw;
      if (s.underline) ctx.fillRect(s.x * cw, top + baseline + 2, spanW, 1);
      if (s.strike) ctx.fillRect(s.x * cw, top + Math.floor(ch / 2), spanW, 1);
    }
  }
  drawCursor(c, colors) {
    const { width: cw, height: ch } = this.metrics;
    const ctx = this.ctx;
    const x = c.x * cw, y = c.y * ch, w = c.wideTail ? cw * 2 : cw;
    const color = colors.cursorHasValue ? colors.cursor : this.theme.cursor;
    ctx.fillStyle = css(color);
    const style = this.cursorStyleOpt === "block" ? c.style : this.cursorStyleOpt;
    if (style === "bar") ctx.fillRect(x, y, 2, ch);
    else if (style === "underline") ctx.fillRect(x, y + ch - 2, w, 2);
    else if (style === "block_hollow") {
      ctx.strokeStyle = css(color);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, ch - 1);
    } else ctx.fillRect(x, y, w, ch);
  }
  setFont(size, family) {
    this.fontSize = size;
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }
  dispose() {
    if (this.blinkTimer) clearInterval(this.blinkTimer);
  }
}
const KEY_MAP = {
  // Letters
  KeyA: Key.A,
  KeyB: Key.B,
  KeyC: Key.C,
  KeyD: Key.D,
  KeyE: Key.E,
  KeyF: Key.F,
  KeyG: Key.G,
  KeyH: Key.H,
  KeyI: Key.I,
  KeyJ: Key.J,
  KeyK: Key.K,
  KeyL: Key.L,
  KeyM: Key.M,
  KeyN: Key.N,
  KeyO: Key.O,
  KeyP: Key.P,
  KeyQ: Key.Q,
  KeyR: Key.R,
  KeyS: Key.S,
  KeyT: Key.T,
  KeyU: Key.U,
  KeyV: Key.V,
  KeyW: Key.W,
  KeyX: Key.X,
  KeyY: Key.Y,
  KeyZ: Key.Z,
  // Numbers
  Digit1: Key.DIGIT_1,
  Digit2: Key.DIGIT_2,
  Digit3: Key.DIGIT_3,
  Digit4: Key.DIGIT_4,
  Digit5: Key.DIGIT_5,
  Digit6: Key.DIGIT_6,
  Digit7: Key.DIGIT_7,
  Digit8: Key.DIGIT_8,
  Digit9: Key.DIGIT_9,
  Digit0: Key.DIGIT_0,
  // Special keys
  Enter: Key.ENTER,
  Escape: Key.ESCAPE,
  Backspace: Key.BACKSPACE,
  Tab: Key.TAB,
  Space: Key.SPACE,
  // Punctuation
  Minus: Key.MINUS,
  Equal: Key.EQUAL,
  BracketLeft: Key.BRACKET_LEFT,
  BracketRight: Key.BRACKET_RIGHT,
  Backslash: Key.BACKSLASH,
  Semicolon: Key.SEMICOLON,
  Quote: Key.QUOTE,
  Backquote: Key.BACKQUOTE,
  Comma: Key.COMMA,
  Period: Key.PERIOD,
  Slash: Key.SLASH,
  // Function keys
  CapsLock: Key.CAPS_LOCK,
  F1: Key.F1,
  F2: Key.F2,
  F3: Key.F3,
  F4: Key.F4,
  F5: Key.F5,
  F6: Key.F6,
  F7: Key.F7,
  F8: Key.F8,
  F9: Key.F9,
  F10: Key.F10,
  F11: Key.F11,
  F12: Key.F12,
  // Special function keys
  PrintScreen: Key.PRINT_SCREEN,
  ScrollLock: Key.SCROLL_LOCK,
  Pause: Key.PAUSE,
  Insert: Key.INSERT,
  Home: Key.HOME,
  PageUp: Key.PAGE_UP,
  Delete: Key.DELETE,
  End: Key.END,
  PageDown: Key.PAGE_DOWN,
  // Arrow keys
  ArrowRight: Key.ARROW_RIGHT,
  ArrowLeft: Key.ARROW_LEFT,
  ArrowDown: Key.ARROW_DOWN,
  ArrowUp: Key.ARROW_UP,
  // Keypad
  NumLock: Key.NUM_LOCK,
  NumpadDivide: Key.NUMPAD_DIVIDE,
  NumpadMultiply: Key.NUMPAD_MULTIPLY,
  NumpadSubtract: Key.NUMPAD_SUBTRACT,
  NumpadAdd: Key.NUMPAD_ADD,
  NumpadEnter: Key.NUMPAD_ENTER,
  Numpad1: Key.NUMPAD_1,
  Numpad2: Key.NUMPAD_2,
  Numpad3: Key.NUMPAD_3,
  Numpad4: Key.NUMPAD_4,
  Numpad5: Key.NUMPAD_5,
  Numpad6: Key.NUMPAD_6,
  Numpad7: Key.NUMPAD_7,
  Numpad8: Key.NUMPAD_8,
  Numpad9: Key.NUMPAD_9,
  Numpad0: Key.NUMPAD_0,
  NumpadDecimal: Key.NUMPAD_DECIMAL,
  // International
  IntlBackslash: Key.INTL_BACKSLASH,
  ContextMenu: Key.CONTEXT_MENU,
  // Additional function keys
  F13: Key.F13,
  F14: Key.F14,
  F15: Key.F15,
  F16: Key.F16,
  F17: Key.F17,
  F18: Key.F18,
  F19: Key.F19,
  F20: Key.F20,
  F21: Key.F21,
  F22: Key.F22,
  F23: Key.F23,
  F24: Key.F24
};
class InputHandler {
  encoder;
  container;
  inputElement;
  onDataCallback;
  onBellCallback;
  onKeyCallback;
  customKeyEventHandler;
  getModeCallback;
  onCopyCallback;
  mouseConfig;
  keydownListener = null;
  keypressListener = null;
  pasteListener = null;
  beforeInputListener = null;
  compositionStartListener = null;
  compositionUpdateListener = null;
  compositionEndListener = null;
  mousedownListener = null;
  mouseupListener = null;
  mousemoveListener = null;
  wheelListener = null;
  isComposing = false;
  isDisposed = false;
  mouseButtonsPressed = 0;
  // Track which buttons are pressed for motion reporting
  lastKeyDownData = null;
  lastKeyDownTime = 0;
  lastPasteData = null;
  lastPasteTime = 0;
  lastPasteSource = null;
  lastCompositionData = null;
  lastCompositionTime = 0;
  lastBeforeInputData = null;
  lastBeforeInputTime = 0;
  static BEFORE_INPUT_IGNORE_MS = 100;
  /**
   * Create a new InputHandler
   * @param ghostty - Ghostty instance (for creating KeyEncoder)
   * @param container - DOM element to attach listeners to
   * @param onData - Callback for terminal data (escape sequences to send to PTY)
   * @param onBell - Callback for bell/beep event
   * @param onKey - Optional callback for raw key events
   * @param customKeyEventHandler - Optional custom key event handler
   * @param getMode - Optional callback to query terminal mode state (for application cursor mode)
   * @param onCopy - Optional callback to handle copy (Cmd+C/Ctrl+C with selection)
   * @param inputElement - Optional input element for beforeinput events
   * @param mouseConfig - Optional mouse tracking configuration
   */
  constructor(ghostty, container, onData, onBell, onKey, customKeyEventHandler, getMode, onCopy, inputElement, mouseConfig) {
    this.encoder = ghostty.createKeyEncoder();
    this.container = container;
    this.inputElement = inputElement;
    this.onDataCallback = onData;
    this.onBellCallback = onBell;
    this.onKeyCallback = onKey;
    this.customKeyEventHandler = customKeyEventHandler;
    this.getModeCallback = getMode;
    this.onCopyCallback = onCopy;
    this.mouseConfig = mouseConfig;
    this.attach();
  }
  /**
   * Set custom key event handler (for runtime updates)
   */
  setCustomKeyEventHandler(handler) {
    this.customKeyEventHandler = handler;
  }
  /**
   * Attach keyboard event listeners to container
   */
  attach() {
    if (typeof this.container.hasAttribute === "function" && typeof this.container.setAttribute === "function") {
      if (!this.container.hasAttribute("tabindex")) {
        this.container.setAttribute("tabindex", "0");
      }
      if (this.container.style) {
        this.container.style.outline = "none";
      }
    }
    this.keydownListener = this.handleKeyDown.bind(this);
    this.container.addEventListener("keydown", this.keydownListener);
    this.pasteListener = this.handlePaste.bind(this);
    this.container.addEventListener("paste", this.pasteListener);
    if (this.inputElement && this.inputElement !== this.container) {
      this.inputElement.addEventListener("paste", this.pasteListener);
    }
    if (this.inputElement) {
      this.beforeInputListener = this.handleBeforeInput.bind(this);
      this.inputElement.addEventListener("beforeinput", this.beforeInputListener);
    }
    this.compositionStartListener = this.handleCompositionStart.bind(this);
    this.container.addEventListener("compositionstart", this.compositionStartListener);
    this.compositionUpdateListener = this.handleCompositionUpdate.bind(this);
    this.container.addEventListener("compositionupdate", this.compositionUpdateListener);
    this.compositionEndListener = this.handleCompositionEnd.bind(this);
    this.container.addEventListener("compositionend", this.compositionEndListener);
    this.mousedownListener = this.handleMouseDown.bind(this);
    this.container.addEventListener("mousedown", this.mousedownListener);
    this.mouseupListener = this.handleMouseUp.bind(this);
    this.container.addEventListener("mouseup", this.mouseupListener);
    this.mousemoveListener = this.handleMouseMove.bind(this);
    this.container.addEventListener("mousemove", this.mousemoveListener);
    this.wheelListener = this.handleWheel.bind(this);
    this.container.addEventListener("wheel", this.wheelListener, { passive: false });
  }
  /**
   * Map KeyboardEvent.code to USB HID Key enum value
   * @param code - KeyboardEvent.code value
   * @returns Key enum value or null if unmapped
   */
  mapKeyCode(code) {
    return KEY_MAP[code] ?? null;
  }
  /**
   * Extract modifier flags from KeyboardEvent
   * @param event - KeyboardEvent
   * @returns Mods flags
   */
  extractModifiers(event) {
    let mods = Mods.NONE;
    if (event.shiftKey) mods |= Mods.SHIFT;
    if (event.ctrlKey) mods |= Mods.CTRL;
    if (event.altKey) mods |= Mods.ALT;
    if (event.metaKey) mods |= Mods.SUPER;
    return mods;
  }
  /**
   * Check if this is a printable character with no special modifiers
   * @param event - KeyboardEvent
   * @returns true if printable character
   */
  isPrintableCharacter(event) {
    if (event.ctrlKey && !event.altKey) return false;
    if (event.altKey && !event.ctrlKey) return false;
    if (event.metaKey) return false;
    return event.key.length === 1;
  }
  /**
   * Handle keydown event
   * @param event - KeyboardEvent
   */
  handleKeyDown(event) {
    if (this.isDisposed) return;
    if (this.isComposing || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (this.onKeyCallback) {
      this.onKeyCallback({ key: event.key, domEvent: event });
    }
    if (this.customKeyEventHandler) {
      const handled = this.customKeyEventHandler(event);
      if (handled) {
        event.preventDefault();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyV") {
      return;
    }
    if (event.metaKey && event.code === "KeyC") {
      if (this.onCopyCallback && this.onCopyCallback()) {
        event.preventDefault();
      }
      return;
    }
    if (this.isPrintableCharacter(event)) {
      event.preventDefault();
      this.onDataCallback(event.key);
      this.recordKeyDownData(event.key);
      return;
    }
    const key = this.mapKeyCode(event.code);
    if (key === null) {
      return;
    }
    const mods = this.extractModifiers(event);
    if (mods === Mods.NONE || mods === Mods.SHIFT) {
      let simpleOutput = null;
      switch (key) {
        case Key.ENTER:
          simpleOutput = "\r";
          break;
        case Key.TAB:
          if (mods === Mods.SHIFT) {
            simpleOutput = "\x1B[Z";
          } else {
            simpleOutput = "	";
          }
          break;
        case Key.BACKSPACE:
          simpleOutput = "";
          break;
        case Key.ESCAPE:
          simpleOutput = "\x1B";
          break;
        // Arrow keys are handled by the encoder (respects application cursor mode)
        // Navigation keys
        case Key.HOME:
          simpleOutput = "\x1B[H";
          break;
        case Key.END:
          simpleOutput = "\x1B[F";
          break;
        case Key.INSERT:
          simpleOutput = "\x1B[2~";
          break;
        case Key.DELETE:
          simpleOutput = "\x1B[3~";
          break;
        case Key.PAGE_UP:
          simpleOutput = "\x1B[5~";
          break;
        case Key.PAGE_DOWN:
          simpleOutput = "\x1B[6~";
          break;
        // Function keys
        case Key.F1:
          simpleOutput = "\x1BOP";
          break;
        case Key.F2:
          simpleOutput = "\x1BOQ";
          break;
        case Key.F3:
          simpleOutput = "\x1BOR";
          break;
        case Key.F4:
          simpleOutput = "\x1BOS";
          break;
        case Key.F5:
          simpleOutput = "\x1B[15~";
          break;
        case Key.F6:
          simpleOutput = "\x1B[17~";
          break;
        case Key.F7:
          simpleOutput = "\x1B[18~";
          break;
        case Key.F8:
          simpleOutput = "\x1B[19~";
          break;
        case Key.F9:
          simpleOutput = "\x1B[20~";
          break;
        case Key.F10:
          simpleOutput = "\x1B[21~";
          break;
        case Key.F11:
          simpleOutput = "\x1B[23~";
          break;
        case Key.F12:
          simpleOutput = "\x1B[24~";
          break;
      }
      if (simpleOutput !== null) {
        event.preventDefault();
        this.onDataCallback(simpleOutput);
        this.recordKeyDownData(simpleOutput);
        return;
      }
    }
    const action = KeyAction.PRESS;
    try {
      if (this.getModeCallback) {
        const appCursorMode = this.getModeCallback(1);
        this.encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, appCursorMode);
      }
      const utf8 = event.key.length === 1 && event.key.charCodeAt(0) < 128 ? event.key.toLowerCase() : void 0;
      const encoded = this.encoder.encode({
        action,
        key,
        mods,
        utf8
      });
      const decoder = new TextDecoder();
      const data = decoder.decode(encoded);
      event.preventDefault();
      event.stopPropagation();
      if (data.length > 0) {
        this.onDataCallback(data);
        this.recordKeyDownData(data);
      }
    } catch (error) {
      console.warn("Failed to encode key:", event.code, error);
    }
  }
  /**
   * Handle paste event from clipboard
   * @param event - ClipboardEvent
   */
  handlePaste(event) {
    if (this.isDisposed) return;
    event.preventDefault();
    event.stopPropagation();
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      console.warn("No clipboard data available");
      return;
    }
    const text = clipboardData.getData("text/plain");
    if (!text) {
      console.warn("No text in clipboard");
      return;
    }
    if (this.shouldIgnorePasteEvent(text, "paste")) {
      return;
    }
    this.emitPasteData(text);
    this.recordPasteData(text, "paste");
  }
  /**
   * Handle beforeinput event (mobile/IME input)
   * @param event - InputEvent
   */
  handleBeforeInput(event) {
    if (this.isDisposed) return;
    if (this.isComposing || event.isComposing) {
      return;
    }
    const inputType = event.inputType;
    const data = event.data ?? "";
    let output = null;
    switch (inputType) {
      case "insertText":
      case "insertReplacementText":
        output = data.length > 0 ? data.replace(/\n/g, "\r") : null;
        break;
      case "insertLineBreak":
      case "insertParagraph":
        output = "\r";
        break;
      case "deleteContentBackward":
        output = "";
        break;
      case "deleteContentForward":
        output = "\x1B[3~";
        break;
      case "insertFromPaste":
        if (!data) {
          return;
        }
        if (this.shouldIgnorePasteEvent(data, "beforeinput")) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.emitPasteData(data);
        this.recordPasteData(data, "beforeinput");
        return;
      default:
        return;
    }
    if (!output) {
      return;
    }
    if (this.shouldIgnoreBeforeInput(output)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (data && this.shouldIgnoreBeforeInputFromComposition(data)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.onDataCallback(output);
    if (data) {
      this.recordBeforeInputData(data);
    }
  }
  /**
   * Handle compositionstart event
   */
  handleCompositionStart(_event) {
    if (this.isDisposed) return;
    this.isComposing = true;
  }
  /**
   * Handle compositionupdate event
   */
  handleCompositionUpdate(_event) {
    if (this.isDisposed) return;
  }
  /**
   * Handle compositionend event
   */
  handleCompositionEnd(event) {
    if (this.isDisposed) return;
    this.isComposing = false;
    const data = event.data;
    if (data && data.length > 0) {
      if (this.shouldIgnoreCompositionEnd(data)) {
        this.cleanupCompositionTextNodes();
        return;
      }
      this.onDataCallback(data);
      this.recordCompositionData(data);
    }
    this.cleanupCompositionTextNodes();
  }
  /**
   * Cleanup text nodes in container after composition
   */
  cleanupCompositionTextNodes() {
    if (this.container && this.container.childNodes) {
      for (let i = this.container.childNodes.length - 1; i >= 0; i--) {
        const node = this.container.childNodes[i];
        if (node.nodeType === 3) {
          this.container.removeChild(node);
        }
      }
    }
  }
  // ==========================================================================
  // Mouse Event Handling (for terminal mouse tracking)
  // ==========================================================================
  /**
   * Convert pixel coordinates to terminal cell coordinates
   */
  pixelToCell(event) {
    if (!this.mouseConfig) return null;
    const dims = this.mouseConfig.getCellDimensions();
    const offset = this.mouseConfig.getCanvasOffset();
    if (dims.width <= 0 || dims.height <= 0) return null;
    const x = event.clientX - offset.left;
    const y = event.clientY - offset.top;
    const col = Math.floor(x / dims.width) + 1;
    const row = Math.floor(y / dims.height) + 1;
    return {
      col: Math.max(1, col),
      row: Math.max(1, row)
    };
  }
  /**
   * Get modifier flags for mouse event
   */
  getMouseModifiers(event) {
    let mods = 0;
    if (event.shiftKey) mods |= 4;
    if (event.metaKey) mods |= 8;
    if (event.ctrlKey) mods |= 16;
    return mods;
  }
  /**
   * Encode mouse event as SGR sequence
   * SGR format: \x1b[<Btn;Col;RowM (press/motion) or \x1b[<Btn;Col;Rowm (release)
   */
  encodeMouseSGR(button, col, row, isRelease, modifiers) {
    const btn = button + modifiers;
    const suffix = isRelease ? "m" : "M";
    return `\x1B[<${btn};${col};${row}${suffix}`;
  }
  /**
   * Encode mouse event as X10/normal sequence (legacy format)
   * Format: \x1b[M<Btn+32><Col+32><Row+32>
   */
  encodeMouseX10(button, col, row, modifiers) {
    const btn = button + modifiers + 32;
    const colChar = String.fromCharCode(Math.min(col + 32, 255));
    const rowChar = String.fromCharCode(Math.min(row + 32, 255));
    return `\x1B[M${String.fromCharCode(btn)}${colChar}${rowChar}`;
  }
  /**
   * Send mouse event to terminal
   */
  sendMouseEvent(button, col, row, isRelease, event) {
    const modifiers = this.getMouseModifiers(event);
    const useSGR = this.mouseConfig?.hasSgrMouseMode?.() ?? true;
    let sequence;
    if (useSGR) {
      sequence = this.encodeMouseSGR(button, col, row, isRelease, modifiers);
    } else {
      const x10Button = isRelease ? 3 : button;
      sequence = this.encodeMouseX10(x10Button, col, row, modifiers);
    }
    this.onDataCallback(sequence);
  }
  /**
   * Handle mousedown event
   */
  handleMouseDown(event) {
    if (this.isDisposed) return;
    if (!this.mouseConfig?.hasMouseTracking()) return;
    const cell = this.pixelToCell(event);
    if (!cell) return;
    const button = event.button;
    this.mouseButtonsPressed |= 1 << button;
    this.sendMouseEvent(button, cell.col, cell.row, false, event);
  }
  /**
   * Handle mouseup event
   */
  handleMouseUp(event) {
    if (this.isDisposed) return;
    if (!this.mouseConfig?.hasMouseTracking()) return;
    const cell = this.pixelToCell(event);
    if (!cell) return;
    const button = event.button;
    this.mouseButtonsPressed &= ~(1 << button);
    this.sendMouseEvent(button, cell.col, cell.row, true, event);
  }
  /**
   * Handle mousemove event
   */
  handleMouseMove(event) {
    if (this.isDisposed) return;
    if (!this.mouseConfig?.hasMouseTracking()) return;
    const hasButtonMotion = this.getModeCallback?.(1002) ?? false;
    const hasAnyMotion = this.getModeCallback?.(1003) ?? false;
    if (!hasButtonMotion && !hasAnyMotion) return;
    if (hasButtonMotion && !hasAnyMotion && this.mouseButtonsPressed === 0) return;
    const cell = this.pixelToCell(event);
    if (!cell) return;
    let button = 32;
    if (this.mouseButtonsPressed & 1)
      button += 0;
    else if (this.mouseButtonsPressed & 2)
      button += 1;
    else if (this.mouseButtonsPressed & 4) button += 2;
    this.sendMouseEvent(button, cell.col, cell.row, false, event);
  }
  /**
   * Handle wheel event (scroll)
   */
  handleWheel(event) {
    if (this.isDisposed) return;
    if (!this.mouseConfig?.hasMouseTracking()) return;
    const cell = this.pixelToCell(event);
    if (!cell) return;
    const button = event.deltaY < 0 ? 64 : 65;
    this.sendMouseEvent(button, cell.col, cell.row, false, event);
    event.preventDefault();
  }
  /**
   * Emit paste data with bracketed paste support
   */
  emitPasteData(text) {
    const hasBracketedPaste = this.getModeCallback?.(2004) ?? false;
    if (hasBracketedPaste) {
      this.onDataCallback("\x1B[200~" + text + "\x1B[201~");
    } else {
      this.onDataCallback(text);
    }
  }
  /**
   * Record keydown data for beforeinput de-duplication
   */
  recordKeyDownData(data) {
    this.lastKeyDownData = data;
    this.lastKeyDownTime = this.getNow();
  }
  /**
   * Record paste data for beforeinput de-duplication
   */
  recordPasteData(data, source) {
    this.lastPasteData = data;
    this.lastPasteTime = this.getNow();
    this.lastPasteSource = source;
  }
  /**
   * Check if beforeinput should be ignored due to a recent keydown
   */
  shouldIgnoreBeforeInput(data) {
    if (!this.lastKeyDownData) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate = now - this.lastKeyDownTime < InputHandler.BEFORE_INPUT_IGNORE_MS && this.lastKeyDownData === data;
    this.lastKeyDownData = null;
    return isDuplicate;
  }
  /**
   * Check if beforeinput text should be ignored due to a recent composition end
   */
  shouldIgnoreBeforeInputFromComposition(data) {
    if (!this.lastCompositionData) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate = now - this.lastCompositionTime < InputHandler.BEFORE_INPUT_IGNORE_MS && this.lastCompositionData === data;
    if (isDuplicate) {
      this.lastCompositionData = null;
    }
    return isDuplicate;
  }
  /**
   * Check if composition end should be ignored due to a recent beforeinput text
   */
  shouldIgnoreCompositionEnd(data) {
    if (!this.lastBeforeInputData) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate = now - this.lastBeforeInputTime < InputHandler.BEFORE_INPUT_IGNORE_MS && this.lastBeforeInputData === data;
    if (isDuplicate) {
      this.lastBeforeInputData = null;
    }
    return isDuplicate;
  }
  /**
   * Record beforeinput text for composition de-duplication
   */
  recordBeforeInputData(data) {
    this.lastBeforeInputData = data;
    this.lastBeforeInputTime = this.getNow();
  }
  /**
   * Record composition end data for beforeinput de-duplication
   */
  recordCompositionData(data) {
    this.lastCompositionData = data;
    this.lastCompositionTime = this.getNow();
  }
  /**
   * Check if paste should be ignored due to a recent paste event from another source
   */
  shouldIgnorePasteEvent(data, source) {
    if (!this.lastPasteData) {
      return false;
    }
    if (this.lastPasteSource === source) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate = now - this.lastPasteTime < InputHandler.BEFORE_INPUT_IGNORE_MS && this.lastPasteData === data;
    if (isDuplicate) {
      this.lastPasteData = null;
      this.lastPasteSource = null;
    }
    return isDuplicate;
  }
  /**
   * Get current time in milliseconds
   */
  getNow() {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }
  /**
   * Dispose the InputHandler and remove event listeners
   */
  dispose() {
    if (this.isDisposed) return;
    if (this.keydownListener) {
      this.container.removeEventListener("keydown", this.keydownListener);
      this.keydownListener = null;
    }
    if (this.keypressListener) {
      this.container.removeEventListener("keypress", this.keypressListener);
      this.keypressListener = null;
    }
    if (this.pasteListener) {
      this.container.removeEventListener("paste", this.pasteListener);
      if (this.inputElement && this.inputElement !== this.container) {
        this.inputElement.removeEventListener("paste", this.pasteListener);
      }
      this.pasteListener = null;
    }
    if (this.beforeInputListener && this.inputElement) {
      this.inputElement.removeEventListener("beforeinput", this.beforeInputListener);
      this.beforeInputListener = null;
    }
    if (this.compositionStartListener) {
      this.container.removeEventListener("compositionstart", this.compositionStartListener);
      this.compositionStartListener = null;
    }
    if (this.compositionUpdateListener) {
      this.container.removeEventListener("compositionupdate", this.compositionUpdateListener);
      this.compositionUpdateListener = null;
    }
    if (this.compositionEndListener) {
      this.container.removeEventListener("compositionend", this.compositionEndListener);
      this.compositionEndListener = null;
    }
    if (this.mousedownListener) {
      this.container.removeEventListener("mousedown", this.mousedownListener);
      this.mousedownListener = null;
    }
    if (this.mouseupListener) {
      this.container.removeEventListener("mouseup", this.mouseupListener);
      this.mouseupListener = null;
    }
    if (this.mousemoveListener) {
      this.container.removeEventListener("mousemove", this.mousemoveListener);
      this.mousemoveListener = null;
    }
    if (this.wheelListener) {
      this.container.removeEventListener("wheel", this.wheelListener);
      this.wheelListener = null;
    }
    this.isDisposed = true;
  }
  /**
   * Check if handler is disposed
   */
  isActive() {
    return !this.isDisposed;
  }
}
class EventEmitter {
  listeners = [];
  fire(arg) {
    for (const listener of this.listeners) {
      listener(arg);
    }
  }
  event = (listener) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      }
    };
  };
  dispose() {
    this.listeners = [];
  }
}
class Terminal {
  static vt = null;
  // set by init()
  options;
  element = null;
  canvas = null;
  renderer = null;
  textarea = null;
  animationFrameId;
  term = null;
  rs = null;
  encoder = null;
  mouse = null;
  buttons = 0;
  // buttons held down while the application gets mouse reports
  gesture = null;
  input = null;
  disposed = false;
  mouseDown = false;
  forceRepaint = false;
  dataEmitter = new EventEmitter();
  bellEmitter = new EventEmitter();
  titleEmitter = new EventEmitter();
  enc = new TextEncoder();
  dec = new TextDecoder();
  listeners = [];
  onData = this.dataEmitter.event;
  onBell = this.bellEmitter.event;
  onTitleChange = this.titleEmitter.event;
  constructor(options = {}) {
    this.options = { cols: 80, rows: 24, scrollback: 1e3, convertEol: false, fontSize: 15, fontFamily: "monospace", cursorBlink: false, cursorStyle: "block", ...options };
  }
  get cols() {
    return this.term?.cols ?? this.options.cols;
  }
  get rows() {
    return this.term?.rows ?? this.options.rows;
  }
  vt() {
    if (!Terminal.vt) throw new Error("ghostty-web not initialized. Call init() before creating a Terminal");
    return Terminal.vt;
  }
  assertOpen() {
    if (this.disposed) throw new Error("Terminal has been disposed");
    if (!this.term) throw new Error("Terminal is not open");
  }
  open(parent) {
    if (this.term) throw new Error("Terminal is already open");
    if (this.disposed) throw new Error("Terminal has been disposed");
    const vt = this.vt();
    this.element = parent;
    if (!parent.hasAttribute("tabindex")) parent.setAttribute("tabindex", "0");
    parent.setAttribute("role", "textbox");
    parent.setAttribute("aria-label", "Terminal");
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.cursor = "text";
    parent.appendChild(this.canvas);
    const ta = document.createElement("textarea");
    this.textarea = ta;
    for (const [k, v] of Object.entries({ autocorrect: "off", autocapitalize: "off", spellcheck: "false", tabindex: "0", "aria-label": "Terminal input" })) ta.setAttribute(k, v);
    Object.assign(ta.style, { position: "absolute", left: "0", top: "0", width: "1px", height: "1px", padding: "0", border: "none", margin: "0", opacity: "0", clipPath: "inset(50%)", overflow: "hidden", whiteSpace: "nowrap", resize: "none" });
    parent.appendChild(ta);
    const clear = () => {
      if (ta.value) setTimeout(() => {
        ta.value = "";
      }, 0);
    };
    ta.addEventListener("copy", clear);
    ta.addEventListener("keydown", clear);
    this.renderer = new CanvasRenderer(this.canvas, { fontSize: this.options.fontSize, fontFamily: this.options.fontFamily, cursorStyle: this.options.cursorStyle, cursorBlink: this.options.cursorBlink, theme: this.options.theme });
    const theme = this.renderer.resolvedTheme;
    this.term = new VtTerminal(vt, this.options.cols, this.options.rows);
    this.term.setScrollbackMaxLines(this.options.scrollback);
    this.term.setColors({ fg: theme.fg, bg: theme.bg, cursor: theme.cursor, palette: theme.palette256 });
    this.rs = new RenderState(vt);
    this.encoder = new KeyEncoder(vt);
    this.mouse = new MouseEncoder(vt);
    this.gesture = new SelectionGesture(this.term);
    this.term.setWritePty((b) => this.dataEmitter.fire(this.dec.decode(b)));
    this.term.setBell(() => this.bellEmitter.fire());
    this.term.setTitleChanged(() => this.titleEmitter.fire(this.term.title()));
    this.renderer.resize(this.cols, this.rows);
    this.term.resize(this.cols, this.rows, this.renderer.metrics.width, this.renderer.metrics.height);
    const encoder = this.encoder;
    this.input = new InputHandler(
      { createKeyEncoder: () => encoder },
      parent,
      (data) => {
        if (!this.options.disableStdin) {
          this.term?.scrollBottom();
          this.dataEmitter.fire(data);
        }
      },
      () => this.bellEmitter.fire(),
      void 0,
      // Ctrl+Shift+C copies (Linux/Windows terminals); never an interrupt, even with nothing selected
      (e) => {
        if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.code !== "KeyC") return false;
        this.copySelection();
        return true;
      },
      (mode) => this.term?.getMode(mode) ?? false,
      () => this.copySelection(),
      ta,
      {
        hasMouseTracking: () => false,
        hasSgrMouseMode: () => false,
        getCellDimensions: () => ({ width: this.renderer.metrics.width, height: this.renderer.metrics.height }),
        getCanvasOffset: () => {
          const r = this.canvas.getBoundingClientRect();
          return { left: r.left, top: r.top };
        }
      }
    );
    this.wireMouse();
    this.startRenderLoop();
  }
  cellAt(ev) {
    const r = this.canvas.getBoundingClientRect();
    const m = this.renderer.metrics;
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    return { x: Math.max(0, Math.min(this.cols - 1, Math.floor(px / m.width))), y: Math.max(0, Math.min(this.rows - 1, Math.floor(py / m.height))), px, py };
  }
  /** Whether the application asked for mouse reports. Shift keeps the mouse for selection. */
  reporting(e) {
    return !e.shiftKey && [9, 1e3, 1002, 1003].some((mode) => this.term.getMode(mode));
  }
  report(e, action, button) {
    const m = this.renderer.metrics, r = this.canvas.getBoundingClientRect(), mouse = this.mouse;
    const mods = (e.shiftKey ? Mods.SHIFT : 0) | (e.ctrlKey ? Mods.CTRL : 0) | (e.altKey ? Mods.ALT : 0) | (e.metaKey ? Mods.SUPER : 0);
    mouse.syncFromTerminal(this.term);
    mouse.setSize(this.cols, this.rows, m.width, m.height);
    mouse.setAnyButtonPressed(this.buttons !== 0);
    const bytes = mouse.encode({ action, button, mods, x: e.clientX - r.left, y: e.clientY - r.top });
    if (bytes.length && !this.options.disableStdin) this.dataEmitter.fire(this.dec.decode(bytes));
  }
  wireMouse() {
    const c = this.canvas;
    const on = (el, k, fn, opts) => {
      el.addEventListener(k, fn, opts);
      this.listeners.push(() => el.removeEventListener(k, fn, opts));
    };
    const BUTTONS = ["LEFT", "MIDDLE", "RIGHT"];
    on(c, "mousedown", (e) => {
      if (this.textarea.value) this.textarea.value = "";
      if (this.reporting(e) && BUTTONS[e.button]) {
        e.preventDefault();
        this.focus();
        this.buttons |= 1 << e.button;
        this.report(e, "PRESS", BUTTONS[e.button]);
        return;
      }
      if (e.button === 2) {
        e.preventDefault();
        this.armContextMenu(e);
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      this.focus();
      const p = this.cellAt(e);
      this.mouseDown = true;
      this.gesture.press(p.x, p.y, p.px, p.py, Math.round(performance.now() * 1e6));
      this.forceRepaint = true;
    });
    on(window, "mousemove", (e) => {
      if (this.buttons || e.target === c && this.reporting(e)) {
        this.report(e, "MOTION", BUTTONS[Math.log2(this.buttons & -this.buttons)]);
        return;
      }
      if (!this.mouseDown) return;
      const p = this.cellAt(e);
      const m = this.renderer.metrics;
      this.gesture.drag(p.x, p.y, p.px, p.py, { columns: this.cols, cellWidth: m.width, paddingLeft: 0, screenHeight: this.rows * m.height });
      this.forceRepaint = true;
    });
    on(window, "mouseup", (e) => {
      if (this.buttons & 1 << e.button) {
        this.buttons &= ~(1 << e.button);
        this.report(e, "RELEASE", BUTTONS[e.button]);
        return;
      }
      if (!this.mouseDown) return;
      this.mouseDown = false;
      const p = this.cellAt(e);
      this.gesture.release(p.x, p.y);
    });
    on(c, "wheel", (e) => {
      const m = this.renderer.metrics;
      const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / m.height;
      const n = Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines)));
      if (!n) return;
      e.preventDefault();
      if (this.reporting(e)) {
        for (let i = 0; i < Math.min(Math.abs(n), 5); ++i) this.report(e, "PRESS", n < 0 ? "FOUR" : "FIVE");
        return;
      }
      this.term.scrollDelta(n);
      this.forceRepaint = true;
    }, { passive: false });
    on(c, "contextmenu", (e) => {
      if (this.reporting(e)) e.preventDefault();
    });
  }
  /** Right click: put the hidden textarea under the pointer, holding the selection, so the browser's own
   *  menu offers Copy (the selection, no clipboard permission needed) and Paste (lands in its paste event). */
  armContextMenu(e) {
    const ta = this.textarea, r = this.element.getBoundingClientRect();
    Object.assign(ta.style, { left: `${e.clientX - r.left - 10}px`, top: `${e.clientY - r.top - 10}px`, width: "20px", height: "20px", clipPath: "none", zIndex: "1000" });
    ta.value = this.getSelection();
    ta.focus();
    ta.select();
    setTimeout(() => Object.assign(ta.style, { left: "0", top: "0", width: "1px", height: "1px", clipPath: "inset(50%)", zIndex: "" }), 200);
  }
  copySelection() {
    const text = this.getSelection();
    if (!text) return false;
    void navigator.clipboard?.writeText(text);
    return true;
  }
  write(data, callback) {
    this.assertOpen();
    if (this.options.convertEol && typeof data === "string") data = data.replace(/\n/g, "\r\n");
    this.term.write(typeof data === "string" ? this.enc.encode(data) : data);
    this.encoder.syncFromTerminal(this.term);
    if (callback) requestAnimationFrame(() => callback());
  }
  writeln(data, callback) {
    this.write(data + "\r\n", callback);
  }
  paste(text) {
    this.assertOpen();
    const bracketed = this.term.getMode(2004);
    this.dataEmitter.fire(bracketed ? `\x1B[200~${text}\x1B[201~` : text);
  }
  resize(cols, rows) {
    this.assertOpen();
    cols = Math.max(1, cols | 0);
    rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    this.renderer.resize(cols, rows);
    this.term.resize(cols, rows, this.renderer.metrics.width, this.renderer.metrics.height);
    this.rs.update(this.term);
    this.renderer.render(this.rs, true);
  }
  focus() {
    this.textarea?.focus();
  }
  blur() {
    this.textarea?.blur();
  }
  scrollLines(n) {
    this.term?.scrollDelta(n);
    this.forceRepaint = true;
  }
  scrollToBottom() {
    this.term?.scrollBottom();
    this.forceRepaint = true;
  }
  scrollToTop() {
    this.term?.scrollTop();
    this.forceRepaint = true;
  }
  getSelection() {
    return this.term?.selectionText() ?? "";
  }
  hasSelection() {
    return this.getSelection().length > 0;
  }
  clearSelection() {
    this.term?.clearSelection();
    this.gesture?.reset();
    this.forceRepaint = true;
  }
  clear() {
    this.write("\x1B[H\x1B[2J");
  }
  loadAddon(addon) {
    addon.activate(this);
  }
  /** RAF loop; hosts may cancel `animationFrameId` and call startRenderLoop() again to resume. */
  startRenderLoop() {
    if (this.animationFrameId !== void 0) return;
    const frame = () => {
      this.animationFrameId = requestAnimationFrame(frame);
      if (!this.term || !this.rs || !this.renderer) return;
      this.rs.update(this.term);
      const force = this.forceRepaint;
      this.forceRepaint = false;
      this.renderer.render(this.rs, force);
    };
    this.animationFrameId = requestAnimationFrame(frame);
  }
  stopRenderLoop() {
    if (this.animationFrameId !== void 0) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = void 0;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRenderLoop();
    for (const off of this.listeners) off();
    this.listeners = [];
    this.input?.dispose();
    this.input = null;
    this.gesture?.free();
    this.gesture = null;
    this.encoder?.dispose();
    this.encoder = null;
    this.mouse?.dispose();
    this.mouse = null;
    this.rs?.free();
    this.rs = null;
    this.term?.free();
    this.term = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas?.remove();
    this.textarea?.remove();
    this.dataEmitter.dispose();
    this.bellEmitter.dispose();
    this.titleEmitter.dispose();
  }
}
const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
const DEFAULT_SCROLLBAR_WIDTH = 15;
const RESIZE_DEBOUNCE_MS = 100;
class FitAddon {
  _terminal;
  _resizeObserver;
  _resizeDebounceTimer;
  _lastCols;
  _lastRows;
  _isResizing = false;
  /**
   * Activate the addon (called by Terminal.loadAddon)
   */
  activate(terminal) {
    this._terminal = terminal;
  }
  /**
   * Dispose the addon and clean up resources
   */
  dispose() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = void 0;
    }
    if (this._resizeDebounceTimer) {
      clearTimeout(this._resizeDebounceTimer);
      this._resizeDebounceTimer = void 0;
    }
    this._lastCols = void 0;
    this._lastRows = void 0;
    this._terminal = void 0;
  }
  /**
   * Fit the terminal to its container
   *
   * Calculates optimal dimensions and resizes the terminal.
   * Does nothing if dimensions cannot be calculated or haven't changed.
   */
  fit() {
    if (this._isResizing) {
      return;
    }
    const dims = this.proposeDimensions();
    if (!dims || !this._terminal) {
      return;
    }
    const terminal = this._terminal;
    const currentCols = terminal.cols;
    const currentRows = terminal.rows;
    if (dims.cols === this._lastCols && dims.rows === this._lastRows || dims.cols === currentCols && dims.rows === currentRows) {
      return;
    }
    this._lastCols = dims.cols;
    this._lastRows = dims.rows;
    this._isResizing = true;
    try {
      if (terminal.resize && typeof terminal.resize === "function") {
        terminal.resize(dims.cols, dims.rows);
      }
    } finally {
      setTimeout(() => {
        this._isResizing = false;
      }, 50);
    }
  }
  /**
   * Propose dimensions to fit the terminal to its container
   *
   * Calculates cols and rows based on:
   * - Terminal container element dimensions (clientWidth/Height)
   * - Terminal element padding
   * - Font metrics (character cell size)
   * - Scrollbar width reservation
   *
   * @returns Proposed dimensions or undefined if cannot calculate
   */
  proposeDimensions() {
    if (!this._terminal?.element) {
      return void 0;
    }
    const terminal = this._terminal;
    const renderer = terminal.renderer;
    if (!renderer || typeof renderer.getMetrics !== "function") {
      return void 0;
    }
    const metrics = renderer.getMetrics();
    if (!metrics || metrics.width === 0 || metrics.height === 0) {
      return void 0;
    }
    const terminalElement = this._terminal.element;
    if (typeof terminalElement.clientWidth === "undefined") {
      return void 0;
    }
    const elementStyle = window.getComputedStyle(terminalElement);
    const paddingTop = Number.parseInt(elementStyle.getPropertyValue("padding-top")) || 0;
    const paddingBottom = Number.parseInt(elementStyle.getPropertyValue("padding-bottom")) || 0;
    const paddingLeft = Number.parseInt(elementStyle.getPropertyValue("padding-left")) || 0;
    const paddingRight = Number.parseInt(elementStyle.getPropertyValue("padding-right")) || 0;
    const containerWidth = terminalElement.clientWidth;
    const containerHeight = terminalElement.clientHeight;
    if (containerWidth === 0 || containerHeight === 0) {
      return void 0;
    }
    const availableWidth = containerWidth - paddingLeft - paddingRight - DEFAULT_SCROLLBAR_WIDTH;
    const availableHeight = containerHeight - paddingTop - paddingBottom;
    const cols = Math.max(MINIMUM_COLS, Math.floor(availableWidth / metrics.width));
    const rows = Math.max(MINIMUM_ROWS, Math.floor(availableHeight / metrics.height));
    return { cols, rows };
  }
  /**
   * Observe the terminal's container for resize events
   *
   * Sets up a ResizeObserver to automatically call fit() when the
   * container size changes. Resize events are debounced to avoid
   * excessive calls during window drag operations.
   *
   * Call dispose() to stop observing.
   */
  observeResize() {
    if (!this._terminal?.element) {
      return;
    }
    if (this._resizeObserver) {
      return;
    }
    this._resizeObserver = new ResizeObserver((entries) => {
      if (this._isResizing) {
        return;
      }
      const entry = entries[0];
      if (!entry) return;
      if (this._resizeDebounceTimer) {
        clearTimeout(this._resizeDebounceTimer);
      }
      this._resizeDebounceTimer = setTimeout(() => {
        this.fit();
      }, RESIZE_DEBOUNCE_MS);
    });
    this._resizeObserver.observe(this._terminal.element);
  }
}
async function init(source) {
  if (Terminal.vt) return;
  if (source instanceof Uint8Array) {
    Terminal.vt = await Vt.load(source);
    return;
  }
  const url = source ?? new URL("ghostty-vt.wasm", import.meta.url);
  Terminal.vt = await Vt.load(fetch(url));
}
export {
  FitAddon,
  Key,
  KeyAction,
  Mods,
  Terminal,
  init
};
