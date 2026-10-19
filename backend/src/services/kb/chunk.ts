import { PageText } from './extract';

export interface Chunk { index: number; content: string; page: number | null; section: string | null }
export interface ChunkOptions { size: number; overlap: number }

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/** Split text into pieces no longer than `size`, preferring paragraph, then sentence, then word boundaries. */
function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = Math.max(rest.lastIndexOf('\n', size), rest.lastIndexOf('. ', size) + 1, rest.lastIndexOf('; ', size) + 1);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.3) cut = size; // no good boundary: hard cut
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** The tail of `text` (about `n` characters) starting on a word boundary - the overlap carried into the next chunk. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? '' : text;
  const slice = text.slice(text.length - n);
  const space = slice.indexOf(' ');
  return (space > 0 && space < n / 2 ? slice.slice(space + 1) : slice).trim();
}

/**
 * Cut extracted pages into overlapping chunks. Each chunk remembers the page it started on and, for
 * Markdown, the heading it sits under. Chunks never exceed `size` + `overlap` characters.
 */
export function chunkPages(pages: PageText[], { size, overlap }: ChunkOptions): Chunk[] {
  if (size < 200) throw new Error('chunk size must be at least 200 characters');
  if (overlap < 0 || overlap >= size / 2) throw new Error('overlap must be between 0 and half the chunk size');

  const chunks: Chunk[] = [];
  let section: string | null = null;

  for (const { page, text } of pages) {
    let current = '';
    let currentSection = section;
    const flush = () => {
      const content = current.trim();
      if (content) chunks.push({ index: chunks.length, content, page, section: currentSection });
    };

    for (const paragraph of text.split(/\n{2,}/)) {
      for (const line of paragraph.split('\n')) {
        const h = HEADING.exec(line.trim());
        if (h) section = h[2].trim().slice(0, 120);
      }
      for (const piece of splitLong(paragraph.trim(), size)) {
        if (!piece) continue;
        if (current && current.length + piece.length + 2 > size) {
          flush();
          current = tail(current, overlap);
          currentSection = section;
        }
        if (!current) currentSection = section;
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
    flush();
  }
  return chunks.map((c, i) => ({ ...c, index: i }));
}
