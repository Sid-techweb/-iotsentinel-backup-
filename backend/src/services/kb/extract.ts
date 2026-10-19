import { parse as parseCsv } from 'csv-parse/sync';
import mammoth from 'mammoth';
import path from 'path';
import { HttpError } from '../../util';

export const MAX_PDF_PAGES = 500;
export const MAX_TEXT_CHARS = 3_000_000;
const MAX_UNCOMPRESSED_ZIP = 200 * 1024 * 1024;

export interface PageText { page: number | null; text: string }
export interface Extracted { pages: PageText[]; pageCount: number | null }

export const ALLOWED_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
} as const;
export type DocExt = keyof typeof ALLOWED_TYPES;

/** Display-safe filename: no path parts, no control or shell-special characters, bounded length. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  const cleaned = base
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, '')
    .replace(/^\.+/, '')
    .trim();
  const ext = path.extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, 100);
  return `${stem || 'document'}${ext.slice(0, 10)}`;
}

/** Validate the extension AND the file's real content. A renamed executable is rejected, not trusted. */
export function detectType(filename: string, buffer: Buffer): { ext: DocExt; mime: string } {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!(ext in ALLOWED_TYPES)) throw new HttpError(415, `Unsupported file type ".${ext}". Allowed: PDF, DOCX, TXT, MD, CSV.`);
  if (buffer.length === 0) throw new HttpError(400, 'The file is empty.');
  const e = ext as DocExt;

  if (e === 'pdf') {
    if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new HttpError(415, 'The file is not a valid PDF (missing %PDF header).');
  } else if (e === 'docx') {
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) throw new HttpError(415, 'The file is not a valid DOCX (not a ZIP container).');
    if (!buffer.includes(Buffer.from('word/document.xml'))) throw new HttpError(415, 'The ZIP file is not a Word document (no word/document.xml).');
    assertZipIsSafe(buffer);
  } else {
    const head = buffer.subarray(0, 8192);
    if (head.includes(0)) throw new HttpError(415, 'The file contains binary data and is not a text document.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new HttpError(415, 'The text file is not valid UTF-8.'); }
  }
  return { ext: e, mime: ALLOWED_TYPES[e] };
}

/** Refuse zip bombs: add up the declared uncompressed sizes from the central directory before unzipping anything. */
export function assertZipIsSafe(buffer: Buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new HttpError(415, 'The DOCX archive is corrupt.');
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new HttpError(415, 'The DOCX archive is corrupt.');
    total += buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28), extraLen = buffer.readUInt16LE(offset + 30), commentLen = buffer.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
    if (total > MAX_UNCOMPRESSED_ZIP) throw new HttpError(413, 'The DOCX expands to an unreasonable size and was rejected.');
  }
}

/** Normalise extracted text: drop control characters, tidy whitespace, keep paragraph breaks. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​‪-‮⁦-⁩]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(buffer: Buffer): Promise<Extracted> {
  // pdfjs-dist is ESM-only; dynamic import keeps this CommonJS build working
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  let pdf: any;
  try {
    pdf = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => undefined);
    throw new HttpError(422, `The PDF could not be read (${(e as Error).message}). It may be encrypted or damaged.`);
  }
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new HttpError(413, `The PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}.`);
    const pages: PageText[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str === 'string') text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      pages.push({ page: i, text: cleanText(text) });
    }
    return { pages, pageCount: pdf.numPages };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

function extractCsv(buffer: Buffer): Extracted {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true });
  } catch (e) {
    throw new HttpError(422, `The CSV could not be parsed: ${(e as Error).message}`);
  }
  // each row becomes "column: value; column: value" so questions about a column or value can match it
  const lines = rows.map((r, i) => `Row ${i + 1}: ` + Object.entries(r).map(([k, v]) => `${k}: ${v}`).join('; '));
  return { pages: [{ page: null, text: cleanText(lines.join('\n')) }], pageCount: null };
}

export async function extractText(ext: DocExt, buffer: Buffer): Promise<Extracted> {
  let result: Extracted;
  switch (ext) {
    case 'pdf': result = await extractPdf(buffer); break;
    case 'docx': {
      let value: string;
      try { value = (await mammoth.extractRawText({ buffer })).value; } catch (e) { throw new HttpError(422, `The DOCX could not be read: ${(e as Error).message}`); }
      result = { pages: [{ page: null, text: cleanText(value) }], pageCount: null };
      break;
    }
    case 'csv': result = extractCsv(buffer); break;
    default: result = { pages: [{ page: null, text: cleanText(buffer.toString('utf8')) }], pageCount: null };
  }
  const total = result.pages.reduce((n, p) => n + p.text.length, 0);
  if (total === 0) throw new HttpError(422, 'No text could be extracted. Scanned or image-only documents are not supported (no OCR).');
  if (total > MAX_TEXT_CHARS) throw new HttpError(413, `The document contains ${total.toLocaleString()} characters; the limit is ${MAX_TEXT_CHARS.toLocaleString()}.`);
  return result;
}
