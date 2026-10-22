# -*- coding: utf-8 -*-
"""Combines Part 1 (cover, certificates, abstract, acknowledgement, list of tables, table of contents) with Part 2 (chapters, appendix,
screenshots, references) into one Word document.

Rules from the student: table of contents without any table or design, only chapter numbers and chapter names in bold;
viva certificate keeps blank underlines for the name, registration number and date; first line of every paragraph starts with a tab and
paragraphs are justified.
"""
import os
import re
import sys

from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

import build_report as b
from build_report import (CH1, CH2, CH3, CH4, CH5, CH6, add_bookmark, add_field, add_inline, appendix, body, chapter, new_document, references,
                          screenshots, set_font)

HERE = b.HERE
OUT = os.path.join(HERE, 'IoT_Sentinel_Final_Report.docx')
LOGO = os.path.join(HERE, 'ref', 'logo_p1_Image11.jpg')

NAME = 'Siddharth S'
REG = '310624243179'
TITLE = 'IOT DEVICE HEALTH AND SECURITY MONITORING PLATFORM WITH AI MAINTENANCE ASSISTANT'
DEGREE = 'BACHELOR OF TECHNOLOGY'
DEPARTMENT = 'ARTIFICIAL INTELLIGENCE AND DATA SCIENCE'
MONTH_YEAR = 'OCTOBER 2026'
CENTER = WD_ALIGN_PARAGRAPH.CENTER


def para(doc, text='', size=14, bold=False, italic=False, align=CENTER, before=0, after=0, color=None, spacing=1.0, keep_next=False):
    p = doc.add_paragraph()
    p.alignment = align
    pf = p.paragraph_format
    pf.space_before, pf.space_after, pf.line_spacing, pf.keep_with_next = Pt(before), Pt(after), spacing, keep_next
    if text:
        set_font(p.add_run(text), size, bold, italic, color=color)
    return p


# ------------------------------------------------------------------------------------------------ front matter pages


def cover(doc):
    para(doc, TITLE, 16, True, before=0, after=26)
    para(doc, 'A PROJECT REPORT', 14, True, after=8)
    para(doc, 'Submitted by', 14, True, True, after=4, color='7F7F7F')
    para(doc, f'{NAME} ({REG})', 14, True, after=14)
    para(doc, 'in partial fulfillment for the award of the Degree', 14, True, True, after=12)
    para(doc, 'of', 14, True, True, after=14)
    para(doc, DEGREE, 14, True, after=12)
    para(doc, 'In', 12, True, True, after=12)
    para(doc, DEPARTMENT, 14, True, after=18)
    p = doc.add_paragraph()
    p.alignment = CENTER
    p.paragraph_format.space_after = Pt(36)
    p.add_run().add_picture(LOGO, width=Inches(1.7))
    para(doc, 'EASWARI ENGINEERING COLLEGE,', 14, True, after=4)
    para(doc, '(AN AUTONOMOUS INSTITUTION)', 12, True, after=4)
    para(doc, 'AFFILIATED TO ANNA UNIVERSITY,', 12, True, after=4)
    para(doc, 'CHENNAI', 12, True, after=22)
    para(doc, MONTH_YEAR, 14, True)


def college_header(doc, first=False):
    """Logo on the left, college name in the middle (an invisible layout table, as in the certificates of Part 1)."""
    t = doc.add_table(rows=1, cols=2)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    widths = (1.0, 5.27)
    for i, c in enumerate(t.rows[0].cells):
        c.width = Inches(widths[i])
    c0, c1 = t.rows[0].cells
    c0.paragraphs[0].add_run().add_picture(LOGO, width=Inches(0.85))
    c1.vertical_alignment = 1  # centre
    p = c1.paragraphs[0]
    p.alignment = CENTER
    set_font(p.add_run('EASWARI ENGINEERING COLLEGE'), 16, True)


def bonafide(doc):
    college_header(doc)
    para(doc, 'BONAFIDE CERTIFICATE', 14, True, before=28, after=26)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.line_spacing = 2.0
    set_font(p.add_run('\tCertified that this project report titled '), 14)
    set_font(p.add_run(f'“{TITLE}”'), 14, True)
    set_font(p.add_run(' is the Bonafide work of '), 14)
    set_font(p.add_run(f'“{NAME.upper()} ({REG})”,'), 14, True)
    set_font(p.add_run(' who carried out the project work under my supervision.'), 14)
    para(doc, '', after=0, before=150)

    def two(left, right, size=12, bold=False):
        q = doc.add_paragraph()
        q.paragraph_format.tab_stops.add_tab_stop(Inches(3.55), WD_TAB_ALIGNMENT.LEFT)
        q.paragraph_format.line_spacing = 1.0
        set_font(q.add_run(left), size, bold)
        set_font(q.add_run('\t' + right), size, bold)

    two('HEAD OF THE DEPARTMENT', 'SUPERVISOR', 12, True)
    two('Dr. T. Kalai Selvi', 'Ms. D S K Harshitha', 12, True)
    two('Easwari Engineering College', 'Easwari Engineering College')
    two('Ramapuram, Chennai - 600089', 'Ramapuram, Chennai - 600089')


def blank(p, width=28, size=14, underline=True):
    r = p.add_run(' ' * width)
    set_font(r, size)
    r.underline = underline


def typed(p, text, size=14):
    r = p.add_run(text)
    set_font(r, size)
    r.underline = True


def bold(p, text, size=14):
    set_font(p.add_run(text), size, True)


def viva(doc):
    college_header(doc)
    para(doc, 'Certificate of Viva-voce-Examination', 14, True, before=28, after=30)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.line_spacing = 1.5
    set_font(p.add_run('\tThis is to certify that the Viva Voce Examination of the Project Work entitled '), 14)
    bold(p, '\u201cIoT Device Health and Security Monitoring Platform with AI Maintenance Assistant\u201d')
    set_font(p.add_run(' submitted by '), 14)
    bold(p, f'Mr. {NAME}')
    set_font(p.add_run(' (Reg. No. '), 14)
    bold(p, REG)
    set_font(p.add_run(') in partial fulfillment of the requirements for the award of the degree of '), 14)
    bold(p, 'Bachelor of Technology (B.Tech.)')
    set_font(p.add_run(' was conducted on '), 14)
    blank(p, 24)                                   # date of the viva: left blank, to be filled after printing
    set_font(p.add_run(' (Date) in the Department of '), 14)
    bold(p, 'Artificial Intelligence and Data Science')
    set_font(p.add_run(', Easwari Engineering College, Ramapuram \u2013 Chennai.'), 14)
    para(doc, '', before=70)
    q = doc.add_paragraph()
    q.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_font(q.add_run('Internal Examiner'), 14, True)
    q2 = doc.add_paragraph()
    q2.alignment = WD_ALIGN_PARAGRAPH.LEFT
    q2.paragraph_format.space_before = Pt(10)
    set_font(q2.add_run('Date:'), 14)


ABSTRACT = [
    "Connected devices such as sensors, controllers, pumps and machine tools generate a continuous stream of readings, yet maintenance teams usually learn of a problem only after a fixed limit has been crossed, and the knowledge needed to interpret it stays in manuals that nobody has time to search. This project presents IoT Sentinel, a secure and locally deployable platform that monitors the health and security of heterogeneous IoT devices, predicts imminent limit breaches with an explanation, and answers maintenance questions from live data and uploaded documents with verifiable sources.",
    "The platform accepts readings of eight signals over a REST API authenticated by per-device keys, applies alert limits that can be overridden for each machine type, detects silent devices through expiring heartbeat keys, and tracks firmware, security incidents, maintenance history and an audit trail. A logistic-regression model forecasts, for every signal, the probability that its limit will be crossed within the next twenty readings. Each prediction is explained by exact feature contributions, models can be retrained from telemetry, evaluated on newer data, versioned and rolled back, and a retrained model is activated only if it passes a validation gate. A knowledge base ingests PDF, DOCX, text and CSV files, and an AI Maintenance Assistant that runs on a local language model answers from read-only live-data tools and from documents retrieved by hybrid vector and keyword search under the user's own access rights. Citations are verified, document text is treated as untrusted data, and the assistant can never modify the system.",
    "The system is implemented with React and TypeScript, Node.js and Express.js, MongoDB for operational data, PostgreSQL with pgvector for retrieval, Redis and Docker. It is verified by 176 backend tests, 39 front-end tests and a thirteen-step browser test, all passing. The prediction model reaches an AUC of 0.94 on held-out synthetic episodes; this describes the synthetic generator and not real machines, and the report states this and the other limitations of the work openly.",
]
KEYWORDS = "IoT monitoring, predictive maintenance, anomaly prediction, explainable models, retrieval-augmented generation, MongoDB, pgvector."


def abstract(doc):
    p = doc.add_paragraph(style='Heading 1')
    p.paragraph_format.page_break_before = True
    set_font(p.add_run('ABSTRACT'), 14, True, color='000000')
    add_bookmark(p, 'abstract')
    for t in ABSTRACT:
        body(doc, t)


ACK = [
    "We express our sincere gratitude to the Principal Dr. P. Deiva Sundari and the Management of our college for providing us with the opportunity to carry out this project work.",
    "We convey our heartfelt thanks to the Head of the Department Dr. T. KalaiSelvi, Department of Artificial Intelligence and Data Science, for the continuous encouragement and support.",
    "We are extremely thankful to our Project Guide Ms. D. S. K. Harshitha, Department of Artificial Intelligence and Data Science for valuable guidance, suggestions, and motivation throughout the completion of this project.",
    "We would also like to extend our gratitude to all the faculty members of the Department of Artificial Intelligence and Data Science for their support.",
    "Finally, we thank our parents and friends for their constant encouragement and help during the course of this project.",
]


def acknowledgement(doc):
    p = doc.add_paragraph(style='Heading 1')
    p.paragraph_format.page_break_before = True
    set_font(p.add_run('ACKNOWLEDGEMENT'), 14, True, color='000000')
    add_bookmark(p, 'ack')
    for t in ACK:
        body(doc, t, size=12, spacing=1.5, after=6)


# ------------------------------------------------------------------------------------------------ list of tables and table of contents


def tab_para(doc, centers, left=None, after=6):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_after = Pt(after)
    pf.line_spacing = 1.15
    pf.keep_together = True
    for c in centers:
        pf.tab_stops.add_tab_stop(Inches(c), WD_TAB_ALIGNMENT.CENTER)
    if left is not None:
        pf.tab_stops.add_tab_stop(Inches(left), WD_TAB_ALIGNMENT.LEFT)
    return p


def entry(doc, num, title, bm, bold=False, wide=False):
    p = tab_para(doc, [0.8 if wide else 0.85, 6.0 if wide else 5.95], left=1.5 if wide else 1.75, after=3 if not wide else 6)
    # order of stops: centre 0.85 (number), left 1.75 (title), centre 5.95 (page)
    set_font(p.add_run('\t'), 12)
    set_font(p.add_run(num), 12, bold)
    set_font(p.add_run('\t'), 12)
    set_font(p.add_run(title), 12, bold)
    set_font(p.add_run('\t'), 12)
    add_field(p, f'PAGEREF {bm} \\h', '0', 12, False)


def header_row(doc, first, second, third, stops=(0.85, 3.4, 5.95)):
    p = tab_para(doc, list(stops), after=10)
    for i, t in enumerate((first, second, third)):
        set_font(p.add_run('\t'), 13, True)
        set_font(p.add_run(t), 13, True)


def list_of_tables(doc):
    p = doc.add_paragraph(style='Heading 1')
    p.paragraph_format.page_break_before = True
    set_font(p.add_run('LIST OF TABLES'), 14, True, color='000000')
    add_bookmark(p, 'lot')
    header_row(doc, 'TABLE NO.', 'TITLE', 'PAGE No.', stops=(0.8, 3.5, 6.0))
    for ch in (CH1, CH2, CH3, CH4, CH5, CH6):
        for _, _, blocks in ch['sections']:
            for blk in blocks:
                if blk[0] == 'table':
                    m = re.match(r'Table (\d+\.\d+):\s*(.*)', blk[1])
                    num, title = m.group(1), m.group(2)
                    entry(doc, num, title, 'tbl_' + num.replace('.', '_'), wide=True)


def table_of_contents(doc):
    p = doc.add_paragraph()
    p.paragraph_format.page_break_before = True
    p.alignment = CENTER
    p.paragraph_format.space_after = Pt(12)
    set_font(p.add_run('TABLE OF CONTENTS'), 14, True)
    header_row(doc, 'CHAPTER NO.', 'TITLE', 'PAGE No.')
    entry(doc, '', 'ABSTRACT', 'abstract')
    entry(doc, '', 'ACKNOWLEDGEMENT', 'ack')
    entry(doc, '', 'LIST OF TABLES', 'lot')
    for ch in (CH1, CH2, CH3, CH4, CH5, CH6):
        entry(doc, ch['num'], ch['title'], f"ch{ch['num']}", bold=True)
        for num, title, _ in ch['sections']:
            entry(doc, '', f'{num} {title}', 's_' + num.replace('.', '_'))
    entry(doc, '', 'APPENDIX', 'appendix')
    entry(doc, '', 'SCREENSHOTS OF THE PROJECT', 'screens')
    entry(doc, '', 'REFERENCES', 'refs')


# ------------------------------------------------------------------------------------------------ sections and numbering


def page_numbers(sectpr, fmt, start):
    for old in sectpr.findall(qn('w:pgNumType')):
        sectpr.remove(old)
    el = OxmlElement('w:pgNumType')
    el.set(qn('w:fmt'), fmt)
    el.set(qn('w:start'), str(start))
    # schema order: pgNumType must come before cols / titlePg / docGrid
    anchor = None
    for tag in ('w:cols', 'w:titlePg', 'w:docGrid'):
        anchor = sectpr.find(qn(tag))
        if anchor is not None:
            break
    if anchor is not None:
        anchor.addprevious(el)
    else:
        sectpr.append(el)


def main():
    doc = new_document()
    front = doc.sections[0]
    front.different_first_page_header_footer = True      # the cover carries no page number
    cover(doc)

    p = doc.add_paragraph()
    p.paragraph_format.page_break_before = True
    p.paragraph_format.space_after = Pt(0)
    bonafide(doc)
    q = doc.add_paragraph()
    q.paragraph_format.page_break_before = True
    viva(doc)
    abstract(doc)
    acknowledgement(doc)
    list_of_tables(doc)
    table_of_contents(doc)

    body_sec = doc.add_section(WD_SECTION.NEW_PAGE)
    body_sec.different_first_page_header_footer = False
    body_sec.footer.is_linked_to_previous = False
    fp = body_sec.footer.paragraphs[0]
    for r in list(fp.runs):
        r._r.getparent().remove(r._r)
    fp.alignment = CENTER
    add_field(fp, 'PAGE', '1', 11)
    page_numbers(doc.sections[0]._sectPr, 'lowerRoman', 0)
    page_numbers(doc.sections[1]._sectPr, 'decimal', 1)

    chapters = [CH1, CH2, CH3, CH4, CH5, CH6]
    for i, ch in enumerate(chapters):
        chapter(doc, ch)
        if i == 0:   # the section break already starts a new page
            for para_ in doc.paragraphs:
                if para_.text == 'CHAPTER 1':
                    para_.paragraph_format.page_break_before = False
                    break
    appendix(doc)
    screenshots(doc)
    references(doc)

    cp = doc.core_properties
    cp.title = 'IoT Device Health and Security Monitoring Platform with AI Maintenance Assistant - Project Report'
    cp.author = NAME
    doc.save(OUT)
    print('saved', OUT)


if __name__ == '__main__':
    main()
