// A TEST-ONLY reader for the files xlsx_writer.ts produces.
//
// It deliberately shares NO code with the writer. A writer tested by its own
// helpers proves only that the two agree with each other; this reads the zip
// the way a spreadsheet does — the end-of-central-directory record first, then
// the central directory, then each local header — checks every CRC, inflates
// each part and pulls the cells back out of the sheet XML.

import { inflateRawSync } from "node:zlib";

export interface ZipEntry { name: string; data: Buffer; method: number }

function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) {c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;}
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function unzip(buf: Buffer): ZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
  if (eocd < 0) {throw new Error("not a zip: no end-of-central-directory record");}
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize !== eocd) {throw new Error("central directory does not end where the EOCD says");}
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014B50) {throw new Error(`bad central header at ${String(p)}`);}
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOffset) !== 0x04034B50) {throw new Error(`bad local header for ${name}`);}
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtra = buf.readUInt16LE(localOffset + 28);
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString("utf8");
    if (localName !== name) {throw new Error(`local name ${localName} != central ${name}`);}
    const start = localOffset + 30 + lNameLen + lExtra;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) {throw new Error(`unsupported method ${String(method)} for ${name}`);}
    if (data.length !== size) {throw new Error(`${name}: size ${String(data.length)} != ${String(size)}`);}
    if (crc32(data) !== crc) {throw new Error(`${name}: CRC mismatch`);}
    out.push({ name, data, method });
  }
  return out;
}

export interface ReadCell { ref: string; type: string | null; style: number; value: string }

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Every non-empty cell of one sheet's XML, in document order. */
export function readCells(sheetXml: string): ReadCell[] {
  const cells: ReadCell[] = [];
  const re = /<c r="([A-Z]+\d+)"((?:\s+[a-z]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (let m = re.exec(sheetXml); m; m = re.exec(sheetXml)) {
    const attrs = m[2] ?? "";
    const type = /\st="([^"]+)"/.exec(attrs)?.[1] ?? null;
    const style = Number(/\ss="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const inner = m[3] ?? "";
    const value = type === "inlineStr"
      ? unescapeXml(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? "")
      : unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
    cells.push({ ref: m[1], type, style, value });
  }
  return cells;
}

export interface ReadWorkbook {
  sheetNames: string[];
  /** Rows of cell values by sheet name; numbers come back as numbers. */
  sheets: Record<string, (string | number | boolean | null)[][]>;
  /** The raw cells by sheet name, style indexes included. */
  cells: Record<string, ReadCell[]>;
  entries: ZipEntry[];
}

function refToRc(ref: string): { r: number; c: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) {throw new Error(`bad ref ${ref}`);}
  let c = 0;
  for (const ch of m[1]) {c = c * 26 + (ch.charCodeAt(0) - 64);}
  return { r: Number(m[2]) - 1, c: c - 1 };
}

export function readXlsx(buf: Buffer): ReadWorkbook {
  const entries = unzip(buf);
  const get = (name: string): string => {
    const e = entries.find((x) => x.name === name);
    if (!e) {throw new Error(`missing part ${name}`);}
    return e.data.toString("utf8");
  };
  // Every part named by the content types must exist, and vice versa.
  const types = get("[Content_Types].xml");
  for (const m of types.matchAll(/PartName="\/([^"]+)"/g)) {get(m[1]);}
  const wb = get("xl/workbook.xml");
  const rels = get("xl/_rels/workbook.xml.rels");
  const sheetNames: string[] = [];
  const sheets: ReadWorkbook["sheets"] = {};
  const cellsBy: ReadWorkbook["cells"] = {};
  for (const m of wb.matchAll(/<sheet name="([^"]*)" sheetId="\d+" r:id="(rId\d+)"\/>/g)) {
    const name = unescapeXml(m[1]);
    const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
    if (!target) {throw new Error(`no relationship for ${m[2]}`);}
    const xml = get(`xl/${target}`);
    const cells = readCells(xml);
    const grid: (string | number | boolean | null)[][] = [];
    for (const cell of cells) {
      const { r, c } = refToRc(cell.ref);
      while (grid.length <= r) {grid.push([]);}
      const row = grid[r];
      while (row.length < c) {row.push(null);}
      row[c] = cell.type === "inlineStr" ? cell.value
        : cell.type === "b" ? cell.value === "1"
          : cell.value === "" ? null : Number(cell.value);
    }
    sheetNames.push(name);
    sheets[name] = grid;
    cellsBy[name] = cells;
  }
  return { sheetNames, sheets, cells: cellsBy, entries };
}
