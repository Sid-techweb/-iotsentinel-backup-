import os, re
HERE = os.path.dirname(os.path.abspath(__file__))

# renumber listings sequentially
p = os.path.join(HERE, 'content_ch4_6.py')
c = open(p, encoding='utf8').read()
n = [0]


def sub(m):
    n[0] += 1
    return f'Listing 5.{n[0]}:'


c = re.sub(r'Listing 5\.\d+:', sub, c)
open(p, 'w', encoding='utf8', newline='').write(c)
print('listings renumbered:', n[0])

p = os.path.join(HERE, 'build_final.py')
s = open(p, encoding='utf8').read()

# --- viva certificate in the format of the sample (name, reg. no, title, degree, department typed in bold; only the date left blank)
i = s.index('def viva(doc):')
j = s.index('ABSTRACT = [')
s = s[:i] + '''def bold(p, text, size=14):
    set_font(p.add_run(text), size, True)


def viva(doc):
    college_header(doc)
    para(doc, 'Certificate of Viva-voce-Examination', 14, True, before=28, after=30)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.line_spacing = 1.5
    set_font(p.add_run('\\tThis is to certify that the Viva Voce Examination of the Project Work entitled '), 14)
    bold(p, '\\u201cIoT Device Health and Security Monitoring Platform with AI Maintenance Assistant\\u201d')
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
    set_font(p.add_run(', Easwari Engineering College, Ramapuram \\u2013 Chennai.'), 14)
    para(doc, '', before=70)
    q = doc.add_paragraph()
    q.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_font(q.add_run('Internal Examiner'), 14, True)
    q2 = doc.add_paragraph()
    q2.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    q2.paragraph_format.space_before = Pt(10)
    set_font(q2.add_run('Date:'), 14)
    q2.paragraph_format.right_indent = Inches(0.6)


''' + s[j:]

# --- abstract as ONE paragraph
s = s.replace('''    for t in ABSTRACT:
        body(doc, t)
''', '''    body(doc, ' '.join(ABSTRACT))
''')
# --- acknowledgement body at 12 pt (style guide)
s = s.replace("body(doc, t, size=14, spacing=1.5, after=6)", "body(doc, t, size=12, spacing=1.5, after=6)")
open(p, 'w', encoding='utf8', newline='').write(s)
print('patched build_final.py')
