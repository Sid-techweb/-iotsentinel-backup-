import { Check, Copy } from 'lucide-react';
import { Fragment, ReactNode, useState } from 'react';

/**
 * A small, safe Markdown renderer for assistant answers. It builds React elements only - never HTML
 * strings - so nothing in a model answer (or in a document the model quoted) can inject markup or script.
 * Supports headings, paragraphs, bullet/numbered lists, tables, fenced code (with a copy button), bold,
 * italics, inline code and [S1]/[D1] citation markers.
 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'code'}</span>
        <button className="btn sm ghost" onClick={copy} aria-label="Copy code">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className="code"><code>{code}</code></pre>
    </div>
  );
}

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[(?:S|D)\d+\])/g;

function inline(text: string, onCite?: (id: string) => void, known?: Set<string>): ReactNode[] {
  return text.split(INLINE).filter((p) => p !== '').map((part, i) => {
    if (/^\*\*.+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^`.+`$/.test(part)) return <code key={i} className="inline-code">{part.slice(1, -1)}</code>;
    if (/^\*.+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    const cite = /^\[((?:S|D)\d+)\]$/.exec(part);
    if (cite) {
      const id = cite[1];
      return known && !known.has(id)
        ? <span key={i} className="cite bad" title="This marker does not match any source">{id}</span>
        : <button key={i} type="button" className="cite" onClick={() => onCite?.(id)} aria-label={`Source ${id}`}>{id}</button>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export default function Markdown({ text, onCite, sourceIds }: { text: string; onCite?: (id: string) => void; sourceIds?: string[] }) {
  const known = sourceIds ? new Set(sourceIds) : undefined;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or the end of an answer that is still streaming)
      out.push(<CodeBlock key={key++} code={body.join('\n')} lang={fence[1]} />);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = `h${Math.min(h[1].length + 2, 6)}` as 'h3';
      out.push(<Tag key={key++} className="md-h">{inline(h[2], onCite, known)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div key={key++} className="table-wrap md-table"><table>
          <thead><tr>{head.map((c, n) => <th key={n}>{inline(c, onCite, known)}</th>)}</tr></thead>
          <tbody>{rows.map((r, n) => <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c, onCite, known)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/.test(line);
    const numbered = /^\s*\d+[.)]\s+/.test(line);
    if (bullet || numbered) {
      const items: string[] = [];
      const re = bullet ? /^\s*[-*•]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      while (i < lines.length && re.test(lines[i])) items.push(re.exec(lines[i++])![1]);
      const li = items.map((t, n) => <li key={n}>{inline(t, onCite, known)}</li>);
      out.push(bullet ? <ul key={key++}>{li}</ul> : <ol key={key++}>{li}</ol>);
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={key++}>{para.map((l, n) => <Fragment key={n}>{n > 0 && <br />}{inline(l, onCite, known)}</Fragment>)}</p>);
  }
  return <div className="md">{out}</div>;
}
