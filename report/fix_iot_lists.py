# -*- coding: utf-8 -*-
"""IoT Sentinel report: adds a List of Figures (after the List of Tables, and in the table of contents) and re-centres the
column headings of the list pages so that the word TITLE lines up with the page-centred heading."""
import copy
import re
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH as AL, WD_TAB_ALIGNMENT as TA
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

SRC, DST = sys.argv[1], sys.argv[2]
d = Document(SRC)
ps = d.paragraphs
FONT = 'Times New Roman'
CENTRE = 3.134            # middle of the 6.27 inch text width, where the page-centred headings sit
STOPS = (0.8, CENTRE, 6.0)
_bm = [5000]


def font(r, size=12, bold=False):
    r.font.name = FONT
    rf = r._r.get_or_add_rPr().find(qn('w:rFonts'))
    for a in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
        rf.set(qn(a), FONT)
    r.font.size = Pt(size); r.font.bold = bold
    return r


def bookmark(p, name):
    _bm[0] += 1
    s = OxmlElement('w:bookmarkStart'); s.set(qn('w:id'), str(_bm[0])); s.set(qn('w:name'), name)
    e = OxmlElement('w:bookmarkEnd'); e.set(qn('w:id'), str(_bm[0]))
    ppr = p._p.pPr
    (ppr.addnext(s) if ppr is not None else p._p.insert(0, s))
    s.addnext(e)


def field(p, instr, size=12):
    def piece(child):
        r = font(p.add_run(), size); r._r.append(child)
    b = OxmlElement('w:fldChar'); b.set(qn('w:fldCharType'), 'begin'); piece(b)
    it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve'); it.text = f' {instr} '; piece(it)
    sp = OxmlElement('w:fldChar'); sp.set(qn('w:fldCharType'), 'separate'); piece(sp)
    font(p.add_run('0'), size)
    e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), 'end'); piece(e)


def set_tabs(p, centres, left=None):
    ppr = p._p.get_or_add_pPr()
    for t in ppr.findall(qn('w:tabs')):
        ppr.remove(t)
    pf = p.paragraph_format
    for c in centres:
        pf.tab_stops.add_tab_stop(Inches(c), TA.CENTER)
    if left is not None:
        pf.tab_stops.add_tab_stop(Inches(left), TA.LEFT)


def wrap_title(p):
    pf = p.paragraph_format
    pf.left_indent, pf.first_line_indent, pf.right_indent = Inches(1.5), Inches(-1.5), Inches(0.75)


def header_row(p):
    set_tabs(p, STOPS)


# ---- locate things
lot = next(i for i, p in enumerate(ps) if p.style.name == 'Heading 1' and p.text.strip() == 'LIST OF TABLES')
toc = next(i for i, p in enumerate(ps) if p.text.strip() == 'TABLE OF CONTENTS' and p.style.name == 'Normal')
assert ps[lot + 1].text.strip().startswith('TABLE NO.')
# ---- figure captions: bookmarks + titles
figs = []
for p in ps:
    m = re.match(r'Figure ([\w.]+): (.*)', p.text.strip())
    if m:
        title = re.sub(r'\s*\(upper part of the page\)', '', m.group(2)).strip()
        name = 'fig_' + m.group(1).replace('.', '_')
        bookmark(p, name)
        figs.append((m.group(1), title, name))
assert len(figs) == 22, len(figs)

# ---- list of tables: header aligned under the heading, entries wrap cleanly
header_row(ps[lot + 1])
for p in ps[lot + 2: toc]:
    if p.text.strip():
        set_tabs(p, (0.8, 6.0), left=1.5)
        wrap_title(p)

# ---- table of contents header row
for p in ps[toc + 1: toc + 3]:
    if p.text.strip().startswith('CHAPTER NO.'):
        header_row(p)

# ---- build the list of figures (appended, then moved in front of the table of contents heading)
body = d.element.body
before = len(list(body)) - 1                                   # children before; last one is the final sectPr
h = d.add_paragraph(style='Heading 1')
h.paragraph_format.page_break_before = True
r = font(h.add_run('LIST OF FIGURES'), 14, True)
from docx.shared import RGBColor
r.font.color.rgb = RGBColor(0, 0, 0)
bookmark(h, 'lof')
hr = d.add_paragraph()
hr.paragraph_format.space_after = Pt(10); hr.paragraph_format.line_spacing = 1.15
header_row(hr)
for t in ('FIGURE NO.', 'TITLE', 'PAGE No.'):
    font(hr.add_run('\t'), 13, True); font(hr.add_run(t), 13, True)
for num, title, name in figs:
    p = d.add_paragraph()
    pf = p.paragraph_format
    pf.space_after = Pt(6); pf.line_spacing = 1.15; pf.keep_together = True
    set_tabs(p, (0.8, 6.0), left=1.5)
    wrap_title(p)
    font(p.add_run('\t')); font(p.add_run(num)); font(p.add_run('\t')); font(p.add_run(title)); font(p.add_run('\t'))
    field(p, f'PAGEREF {name} \\h')
kids = list(body)
new = kids[before:-1]
anchor = ps[toc]._p
for e in new:
    anchor.addprevious(e)

# ---- table of contents: add the entry after LIST OF TABLES
src = next(p for p in ps[toc:toc + 12] if p.text.strip().startswith('LIST OF TABLES'))
cp = copy.deepcopy(src._p)
for t in cp.iter(qn('w:t')):
    if t.text == 'LIST OF TABLES':
        t.text = 'LIST OF FIGURES'
for it in cp.iter(qn('w:instrText')):
    it.text = it.text.replace('PAGEREF lot', 'PAGEREF lof')
src._p.addnext(cp)
d.save(DST)
print('saved', DST)
