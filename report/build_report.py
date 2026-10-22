# -*- coding: utf-8 -*-
"""Builds the Part 2 report (chapters 1-6, appendix, screenshots, references) as a Word document.

Formatting follows the reference template: A4, Times New Roman, 14 pt bold chapter titles and headings, every chapter on a new page.
User's rules: the first line of every paragraph starts with a tab, paragraph text is justified.
"""
import json
import os
import re
import sys

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Mm, Pt, RGBColor
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from content_ch1_3 import CH1, CH2, CH3  # noqa: E402
from content_ch4_6 import CH4, CH5, CH6  # noqa: E402

OUT = os.path.join(HERE, 'IoT_Sentinel_Final_Review_Report_Part2.docx')
FONT = 'Times New Roman'
TEXT_W = 6.27  # inches between the margins
_bm_id = [100]

# ---------------------------------------------------------------------------------------------- low-level helpers


def set_font(run, size=None, bold=None, italic=None, name=FONT, color=None):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        rfonts = OxmlElement('w:rFonts')
        rpr.insert(0, rfonts)
    for a in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
        rfonts.set(qn(a), name)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def shade(element_pr, fill):
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), fill)
    element_pr.append(shd)


def add_bookmark(paragraph, name):
    _bm_id[0] += 1
    start = OxmlElement('w:bookmarkStart')
    start.set(qn('w:id'), str(_bm_id[0]))
    start.set(qn('w:name'), name)
    end = OxmlElement('w:bookmarkEnd')
    end.set(qn('w:id'), str(_bm_id[0]))
    paragraph._p.insert(1 if paragraph._p.pPr is not None else 0, start)
    paragraph._p.append(end)


def add_field(paragraph, instr, cached='1', size=12, bold=False):
    """A complex field (PAGE, PAGEREF ...) with a cached result."""
    def r(child):
        run = paragraph.add_run()
        set_font(run, size, bold)
        run._r.append(child)
        return run
    b = OxmlElement('w:fldChar'); b.set(qn('w:fldCharType'), 'begin'); r(b)
    it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve'); it.text = f' {instr} '; r(it)
    sp = OxmlElement('w:fldChar'); sp.set(qn('w:fldCharType'), 'separate'); r(sp)
    run = paragraph.add_run(cached); set_font(run, size, bold)
    e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), 'end'); r(e)


INLINE = re.compile(r'(\*\*.+?\*\*|`.+?`)')


def add_inline(paragraph, text, size=12, bold=False, italic=False):
    for part in INLINE.split(text):
        if not part:
            continue
        if part.startswith('**') and part.endswith('**'):
            set_font(paragraph.add_run(part[2:-2]), size, True, italic)
        elif part.startswith('`') and part.endswith('`'):
            set_font(paragraph.add_run(part[1:-1]), 10, bold, italic, name='Consolas')
        else:
            set_font(paragraph.add_run(part), size, bold, italic)


# ---------------------------------------------------------------------------------------------- document setup


def new_document():
    doc = Document()
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.PORTRAIT
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.left_margin = sec.right_margin = Inches(1)
    sec.top_margin = sec.bottom_margin = Inches(1)
    sec.footer_distance = Inches(0.5)

    normal = doc.styles['Normal']
    normal.font.name = FONT
    normal.font.size = Pt(12)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)
    normal.paragraph_format.space_after = Pt(0)

    for name, size, align in (('Heading 1', 14, WD_ALIGN_PARAGRAPH.CENTER), ('Heading 2', 14, WD_ALIGN_PARAGRAPH.LEFT)):
        st = doc.styles[name]
        st.font.name = FONT
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.italic = False
        st.font.color.rgb = RGBColor(0, 0, 0)
        rpr = st.element.get_or_add_rPr()
        rf = rpr.find(qn('w:rFonts'))
        if rf is None:
            rf = OxmlElement('w:rFonts'); rpr.insert(0, rf)
        for a in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
            rf.set(qn(a), FONT)
        for a in ('w:asciiTheme', 'w:hAnsiTheme', 'w:cstheme', 'w:eastAsiaTheme'):
            if rf.get(qn(a)) is not None:
                del rf.attrib[qn(a)]
        pf = st.paragraph_format
        pf.alignment = align
        pf.space_before = Pt(14)
        pf.space_after = Pt(8)
        pf.keep_with_next = True

    # footer: centred page number
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_field(fp, 'PAGE', '1', 11)
    return doc


def body(doc, text, tab=True, justify=True, size=12, spacing=1.5, after=4, keep_next=False):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY if justify else WD_ALIGN_PARAGRAPH.LEFT
    pf.line_spacing = spacing
    pf.space_after = Pt(after)
    pf.keep_with_next = keep_next
    pf.widow_control = True
    if tab:
        set_font(p.add_run('\t'), size)
    add_inline(p, text, size)
    return p


def lead_paragraph(doc, lead, text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf.line_spacing = 1.5
    pf.space_after = Pt(6)
    set_font(p.add_run('\t'), 12)
    set_font(p.add_run(lead + ' '), 12, True)
    add_inline(p, text)
    return p


def caption(doc, text, before=2, after=10, keep_next=False):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.keep_with_next = keep_next
    set_font(p.add_run(text), 11, True)
    return p


def picture(doc, path, cap, width_in, max_h_in=8.2):
    full = path if os.path.isabs(path) else os.path.join(HERE, path)
    with Image.open(full) as im:
        w, h = im.size
    width = min(width_in, TEXT_W)
    if width * h / w > max_h_in:
        width = max_h_in * w / h
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.space_before = Pt(6)
    p.add_run().add_picture(full, width=Inches(width))
    caption(doc, cap)


def table(doc, cap, header, rows, widths):
    cp = caption(doc, cap, before=6, after=4, keep_next=True)
    m = re.match(r'Table (\d+\.\d+)', cap)
    if m:
        add_bookmark(cp, 'tbl_' + m.group(1).replace('.', '_'))
    scale = TEXT_W / sum(widths)
    widths = [w * scale for w in widths]
    t = doc.add_table(rows=1, cols=len(header))   # no style: the tables are drawn without outlines
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False

    def fill(cell, text, bold=False, fill_color=None, size=10.5):
        cell.text = ''
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(3)
        p.paragraph_format.space_after = Pt(3)
        p.paragraph_format.line_spacing = 1.0
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        add_inline(p, text, size, bold)
        if fill_color:
            shade(cell._tc.get_or_add_tcPr(), fill_color)

    for i, h in enumerate(header):
        fill(t.rows[0].cells[i], h, True)
    trpr = t.rows[0]._tr.get_or_add_trPr()
    th = OxmlElement('w:tblHeader'); th.set(qn('w:val'), 'true'); trpr.append(th)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            fill(cells[i], v)
    for row in t.rows:
        cs = OxmlElement('w:cantSplit'); cs.set(qn('w:val'), 'true'); row._tr.get_or_add_trPr().append(cs)
        for i, c in enumerate(row.cells):
            c.width = Inches(widths[i])
    doc.add_paragraph().paragraph_format.space_after = Pt(4)


def code_block(doc, text, cap=None, size=10):
    size = 10  # style guide: Consolas, 10 pt, left aligned
    lines = text.replace('\t', '    ').rstrip('\n').split('\n')
    for i, line in enumerate(lines):
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.space_after = Pt(0)
        pf.line_spacing = 1.0
        pf.alignment = WD_ALIGN_PARAGRAPH.LEFT
        pf.widow_control = False
        pf.keep_together = True
        pf.left_indent = Inches(0.0)
        if i < len(lines) - 1 and i < 40:
            pf.keep_with_next = False
        shade(p._p.get_or_add_pPr(), 'F2F2F2')
        set_font(p.add_run(line if line else ' '), size, name='Consolas')
    if cap:
        caption(doc, cap, before=4, after=10)
    else:
        doc.add_paragraph().paragraph_format.space_after = Pt(4)


def grab(path, start, end=None, extra=0):
    full = os.path.join(ROOT, path)
    lines = open(full, encoding='utf8').read().split('\n')
    i = next((k for k, l in enumerate(lines) if start in l), None)
    if i is None:
        raise SystemExit(f'start marker not found in {path}: {start!r}')
    if end is None:
        j = next((k for k in range(i + 1, len(lines)) if lines[k].rstrip() in ('}', '};', '});')), None)
    else:
        j = next((k for k in range(i, len(lines)) if end in lines[k]), None)
        if j is not None:
            j += extra
    if j is None:
        raise SystemExit(f'end marker not found in {path}: {end!r}')
    return '\n'.join(lines[i:j + 1])


# ---------------------------------------------------------------------------------------------- chapters


def heading_section(doc, num, title, bm):
    p = doc.add_paragraph(style='Heading 2')
    p.paragraph_format.tab_stops.add_tab_stop(Inches(0.5))
    set_font(p.add_run(f'{num}\t{title}'), 14, True, color='000000')
    add_bookmark(p, bm)
    return p


def chapter(doc, ch):
    p = doc.add_paragraph(style='Heading 1')
    p.paragraph_format.page_break_before = True
    set_font(p.add_run(f"CHAPTER {ch['num']}"), 16, True, color='000000')
    add_bookmark(p, f"ch{ch['num']}")
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    t.paragraph_format.space_after = Pt(10)
    t.paragraph_format.keep_with_next = True
    set_font(t.add_run(ch['title']), 16, True)
    body(doc, ch['intro'])
    for num, title, blocks in ch['sections']:
        heading_section(doc, num, title, 's_' + num.replace('.', '_'))
        render(doc, blocks)


def render(doc, blocks):
    for b in blocks:
        kind = b[0]
        if kind == 'p':
            body(doc, b[1])
        elif kind == 'pb':
            lead_paragraph(doc, b[1], b[2])
        elif kind == 'img':
            picture(doc, b[1], b[2], b[3])
        elif kind == 'table':
            table(doc, b[1], b[2], b[3], b[4])
        elif kind == 'codefile':
            code_block(doc, grab(b[1], b[2], b[3], b[4]), b[5])
        elif kind == 'code':
            code_block(doc, b[1], b[2] if len(b) > 2 else None)


# ---------------------------------------------------------------------------------------------- appendix

STRUCTURE = """iot-sentinel/
|-- backend/
|   |-- migrations/          versioned SQL for PostgreSQL (knowledge base, chats)
|   |-- src/
|   |   |-- config.ts, app.ts, index.ts, auth.ts
|   |   |-- mongo.ts         MongoDB connection, ids, indexes
|   |   |-- db.ts            PostgreSQL pool and migration runner
|   |   |-- redis.ts         Redis client and caches
|   |   |-- routes/          auth, users, devices, telemetry, alerts, rules, anomaly,
|   |   |                    firmware, incidents, webhooks, audit, knowledge,
|   |   |                    assistant, reports, simulator ...
|   |   |-- services/        ingest, alerts, rules, prediction, retrain, sweeper,
|   |   |   |                seed, simulator, webhooks, reports ...
|   |   |   |-- ai/          Ollama provider, planner, tools, RAG, chat store
|   |   |   `-- kb/          extract, chunk, ingest queue, hybrid search
|   |   |-- ml/              features, logistic regression, predictor
|   |   `-- scripts/         importFromPostgres.ts
|   |-- tests/               unit, api, live (opt-in)
|   `-- Dockerfile, package.json
|-- frontend/
|   |-- src/pages/           Dashboard, Devices, Alerts, Anomaly, Reports,
|   |                        Assistant, KnowledgeBase, AuditLog, ...
|   |-- src/components/      charts, explanation panel, Markdown renderer
|   |-- src/api.ts, live.ts  REST/streaming client, Server-Sent Events client
|   `-- tests/, nginx.conf, Dockerfile, package.json
|-- e2e/                     Playwright end-to-end scenario
|-- docker/postgres/         PostgreSQL 16 + pgvector image
|-- docs/                    architecture, API, ML, RAG, database, deployment ...
`-- docker-compose.yml, .env.example, README.md"""

BACKEND_INSTALL = """# backend (Node.js + Express + TypeScript)
mkdir iot-sentinel && cd iot-sentinel
mkdir backend && cd backend
npm init -y
npm install express cors helmet jsonwebtoken bcryptjs zod dotenv multer
npm install mongodb pg ioredis
npm install pdfjs-dist mammoth csv-parse pdfkit
npm install -D typescript tsx @types/node @types/express @types/cors
npm install -D @types/jsonwebtoken @types/multer @types/pg @types/pdfkit
npm install -D vitest supertest @types/supertest pdf-lib oxlint

# infrastructure (MongoDB, PostgreSQL + pgvector, Redis)
docker compose up -d mongo postgres redis

# run
npm run dev                      # API on http://localhost:4000

# frontend (React + TypeScript + Vite)
cd .. && npm create vite@latest frontend -- --template react-ts
cd frontend
npm install react-router-dom @tanstack/react-query recharts lucide-react
npm install -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom oxlint
npm run dev                      # UI on http://localhost:5173 (proxies /api)

# tests
cd ../backend && npm test
cd ../frontend && npm test
cd ../e2e && npm install && npx playwright test"""

STATUS = {200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized'}


def appendix(doc):
    p = doc.add_paragraph(style='Heading 1')
    p.paragraph_format.page_break_before = True
    set_font(p.add_run('APPENDIX'), 14, True, color='000000')
    add_bookmark(p, 'appendix')
    q = doc.add_paragraph()
    q.paragraph_format.space_after = Pt(6)
    set_font(q.add_run('SOURCE CODE:'), 12, True)

    def item(n, title):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(10)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.keep_with_next = True
        set_font(p.add_run(f'{n}. {title}'), 12, True)

    def label(text):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(4)
        p.paragraph_format.space_after = Pt(3)
        p.paragraph_format.keep_with_next = True
        set_font(p.add_run(text), 12, True)

    def cf(label_text, path, start, end=None, extra=0):
        label(label_text)
        code_block(doc, grab(path, start, end, extra))

    item(1, 'Project Structure')
    label('Project Folder Structure')
    code_block(doc, STRUCTURE, size=8)

    item(2, 'Backend Package Installation')
    code_block(doc, BACKEND_INSTALL, size=8.5)

    item(3, 'Database Connection')
    cf('MongoDB connection (backend/src/mongo.ts)', 'backend/src/mongo.ts', 'export const mongo = new MongoClient', 'export const col', 0)
    cf('Atomic integer ids (backend/src/mongo.ts)', 'backend/src/mongo.ts', 'export async function nextId', None)
    cf('PostgreSQL connection for the knowledge base (backend/src/db.ts)', 'backend/src/db.ts', 'export const pool = new Pool', 'export async function q1', 2)

    item(4, 'Environment Variables')
    label('.env.example')
    code_block(doc, open(os.path.join(ROOT, '.env.example'), encoding='utf8').read())


    item(5, 'User Model')
    cf('Role and authenticated user (backend/src/auth.ts)', 'backend/src/auth.ts', "export type Role", 'export interface AuthUser', 0)
    cf('Input validation for registration (backend/src/routes/auth.ts)', 'backend/src/routes/auth.ts', 'const email = z.string()', 'const password = z.string()', 0)
    cf('Stored user document (inside the register handler)', 'backend/src/routes/auth.ts', 'await col(\'users\').insertOne', '}', 0)

    item(6, 'Password Hashing and Registration')
    cf('Password hashing and token signing (backend/src/auth.ts)', 'backend/src/auth.ts', 'export const hashPassword', 'export const signToken', 0)
    cf('Registration controller (backend/src/routes/auth.ts)', 'backend/src/routes/auth.ts', "authRouter.post('/register'", '  res.status(201).json(session(user));', 1)

    item(7, 'Login and JWT Generation')
    cf('Login controller (backend/src/routes/auth.ts)', 'backend/src/routes/auth.ts', "authRouter.post('/login'", '  res.json(session(user));', 1)

    item(8, 'Authentication Middleware')
    cf('JWT middleware and role guards (backend/src/auth.ts)', 'backend/src/auth.ts', '/** Any signed-in user', 'Administrator access required', 1)

    item(9, 'Create API')
    cf('Validation schema (backend/src/routes/devices.ts)', 'backend/src/routes/devices.ts', 'const createSchema', '});', 0)
    cf('Create device handler (backend/src/routes/devices.ts)', 'backend/src/routes/devices.ts', "devicesRouter.post('/', asyncH", '  res.status(201).json', 1)

    item(10, 'Read API')
    cf('List and search devices (backend/src/routes/devices.ts)', 'backend/src/routes/devices.ts', "devicesRouter.get('/', asyncH", '}));', 0)
    cf('Read one device (backend/src/routes/devices.ts)', 'backend/src/routes/devices.ts', "devicesRouter.get('/:id', asyncH", '}));', 0)

    item(11, 'Update')
    cf('Validation schema (backend/src/routes/devices.ts)', 'backend/src/routes/devices.ts', 'const updateSchema', '});', 0)
    cf('Update device handler (backend/src/routes/devices.ts)', 'backend/src/routes/devices.ts', "devicesRouter.patch('/:id'", '(await getDeviceRow(current.id))', 1)

    item(12, 'Delete')
    cf('Delete device handler (backend/src/routes/devices.ts)', 'backend/src/routes/devices.ts', "devicesRouter.delete('/:id'", '  res.status(204).end();', 1)
    cf('Removing a device together with its data (backend/src/mongo.ts)', 'backend/src/mongo.ts', 'export async function deleteDeviceData', None)

    item(13, 'Express Routes')
    cf('Route mounting and middleware order (backend/src/app.ts)', 'backend/src/app.ts', "app.use('/api/auth', authRouter)", "app.use('/api/audit', auditRouter)", 0)

    item(14, 'Main Server File')
    cf('Server start-up (backend/src/index.ts)', 'backend/src/index.ts', 'async function main()', 'main().catch', 0)

    item(15, 'React Login Component')
    cf('Login page (frontend/src/pages/AuthPages.tsx)', 'frontend/src/pages/AuthPages.tsx', 'export function LoginPage', None)

    item(16, 'Admin Dashboard Logic')
    cf('Fetching the dashboard data (frontend/src/pages/Dashboard.tsx)', 'frontend/src/pages/Dashboard.tsx', 'export default function Dashboard', 'const healthy =', 0)
    cf('Polling hook that slows down while push updates are connected (frontend/src/api.ts)', 'frontend/src/api.ts', 'export function useLive', None)

    item(17, 'REST API Request and Response Examples')
    examples = json.load(open(os.path.join(HERE, 'api_examples.json'), encoding='utf8'))
    keep = ('Sign in', 'Create a device', 'Send telemetry (device key)')
    for n, (title, req_line, body_json, status, resp) in enumerate([e for e in examples if e[0] in keep], 1):
        label(f'Example {n}: {title}')
        method, path = req_line.split(' ', 1)
        headers = ['Host: localhost:4000']
        if 'telemetry' in path:
            headers.append('x-api-key: <device key>')
        elif 'auth/login' not in path and title != 'Missing token':
            headers.append('Authorization: Bearer <token>')
        if body_json is not None:
            headers.append('Content-Type: application/json')
        text = f'{method} {path} HTTP/1.1\n' + '\n'.join(headers)
        if body_json is not None:
            text += '\n\n' + json.dumps(body_json, indent=2)
        code_block(doc, text)
        r = f'HTTP/1.1 {status} {STATUS.get(status, "")}'.strip()
        if resp is not None:
            r += '\nContent-Type: application/json\n\n' + json.dumps(resp, indent=2, ensure_ascii=False)
        code_block(doc, r, size=8)


# ---------------------------------------------------------------------------------------------- screenshots & references

SHOTS = [
    ('01-login', 'Sign-in screen'),
    ('03-dashboard', 'Fleet overview dashboard with live health, alerts and predicted risks'),
    ('04-devices', 'Device inventory with status, firmware and latest readings'),
    ('05-device-detail', 'Device detail page with live readings and forecast charts'),
    ('06-alerts', 'Alerts screen (threshold, heartbeat and predictive alerts)'),
    ('07-anomaly-prediction', 'Anomaly prediction: fleet risk ranking and forecast chart with confidence band'),
    ('10-alert-rules', 'Alert rules with per-machine-type limits'),
    ('11-firmware', 'Firmware compliance and roll-outs'),
    ('12-incidents', 'Security incident register'),
    ('13-knowledge-base', 'Knowledge base: upload and search'),
    ('14-assistant-live-data', 'AI Maintenance Assistant answering from live data, with a citation and the tool used'),
    ('15-assistant-document-answer', 'AI Maintenance Assistant answering from an uploaded manual, with the source shown'),
    ('16-reports', 'Reports: preview with filters and CSV / PDF download'),
    ('17-audit-log', 'Audit log (administrators only)'),
    ('18-users', 'User management: the two roles, administrator and viewer (administrators only)'),
    ('19-device-explanation', 'Why this risk? Explanation of a prediction for one device'),
]


def crop_top(path, ratio=0.66):
    """Very tall full-page captures are cut to their top part so that each figure stays readable (two per page)."""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    if h / w <= ratio + 0.02:
        return path, False
    folder = os.path.join(HERE, 'screens_split')
    os.makedirs(folder, exist_ok=True)
    f = os.path.join(folder, os.path.splitext(os.path.basename(path))[0] + '_top.png')
    im.crop((0, 0, w, int(w * ratio))).save(f)
    return f, True


def screenshots(doc):
    p = doc.add_paragraph(style='Heading 1')
    p.paragraph_format.page_break_before = True
    set_font(p.add_run('SCREENSHOTS OF THE PROJECT'), 14, True, color='000000')
    add_bookmark(p, 'screens')
    n = 0
    for stem, title in SHOTS:
        f = os.path.join(HERE, 'screens', stem + '.png')
        if not os.path.exists(f):
            print('missing screenshot', stem)
            continue
        n += 1
        part, cropped = crop_top(f)
        picture(doc, part, f'Figure {n}: {title}' + (' (upper part of the page)' if cropped else ''), 5.5, max_h_in=4.0)


REFERENCES = [
    "J. Lee, B. Bagheri and H.-A. Kao, \"A Cyber-Physical Systems architecture for Industry 4.0-based manufacturing systems,\" Manufacturing Letters, vol. 3, pp. 18-23, 2015.",
    "R. K. Mobley, An Introduction to Predictive Maintenance, 2nd ed. Amsterdam, The Netherlands: Butterworth-Heinemann, 2002.",
    "V. Chandola, A. Banerjee and V. Kumar, \"Anomaly detection: A survey,\" ACM Computing Surveys, vol. 41, no. 3, article 15, pp. 1-58, 2009.",
    "M. Ahmed, A. N. Mahmood and J. Hu, \"A survey of network anomaly detection techniques,\" Journal of Network and Computer Applications, vol. 60, pp. 19-31, 2016.",
    "D. W. Hosmer Jr., S. Lemeshow and R. X. Sturdivant, Applied Logistic Regression, 3rd ed. Hoboken, NJ, USA: Wiley, 2013.",
    "R. T. Fielding, \"Architectural styles and the design of network-based software architectures,\" Ph.D. dissertation, University of California, Irvine, CA, USA, 2000.",
    "M. Jones, J. Bradley and N. Sakimura, \"JSON Web Token (JWT),\" RFC 7519, Internet Engineering Task Force, May 2015.",
    "OWASP Foundation, \"OWASP Top 10 for Large Language Model Applications,\" https://owasp.org/www-project-top-10-for-large-language-model-applications/ (accessed Oct. 2026).",
    "P. Lewis et al., \"Retrieval-augmented generation for knowledge-intensive NLP tasks,\" in Advances in Neural Information Processing Systems 33 (NeurIPS 2020), 2020.",
    "Y. A. Malkov and D. A. Yashunin, \"Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs,\" IEEE Transactions on Pattern Analysis and Machine Intelligence, vol. 42, no. 4, pp. 824-836, 2020.",
    "G. V. Cormack, C. L. A. Clarke and S. Buettcher, \"Reciprocal rank fusion outperforms Condorcet and individual rank learning methods,\" in Proc. 32nd International ACM SIGIR Conference on Research and Development in Information Retrieval, 2009, pp. 758-759.",
    "Qwen Team, \"Qwen2.5 Technical Report,\" arXiv:2412.15115, 2024.",
    "A. Vaswani et al., \"Attention is all you need,\" in Advances in Neural Information Processing Systems 30 (NIPS 2017), 2017.",
    "K. Greshake, S. Abdelnabi, S. Mishra, C. Endres, T. Holz and M. Fritz, \"Not what you've signed up for: Compromising real-world LLM-integrated applications with indirect prompt injection,\" in Proc. 16th ACM Workshop on Artificial Intelligence and Security (AISec), 2023.",
    "A. Kane, \"pgvector: Open-source vector similarity search for Postgres,\" https://github.com/pgvector/pgvector (accessed Oct. 2026).",
    "The PostgreSQL Global Development Group, \"PostgreSQL 16 Documentation,\" https://www.postgresql.org/docs/16/ (accessed Oct. 2026).",
    "MongoDB, Inc., \"MongoDB Manual: Indexes, TTL indexes and the aggregation framework,\" https://www.mongodb.com/docs/manual/ (accessed Oct. 2026).",
    "Redis Ltd., \"Redis documentation: Pub/Sub, key expiration and data types,\" https://redis.io/docs/ (accessed Oct. 2026).",
    "Ollama, \"Ollama documentation and API reference,\" https://github.com/ollama/ollama/blob/main/docs/api.md (accessed Oct. 2026).",
]


def references(doc):
    p = doc.add_paragraph(style='Heading 1')
    p.paragraph_format.page_break_before = True
    set_font(p.add_run('REFERENCES'), 14, True, color='000000')
    add_bookmark(p, 'refs')
    for i, r in enumerate(REFERENCES, 1):
        body(doc, f'[{i}]  {r}', after=3, spacing=1.5)


# ---------------------------------------------------------------------------------------------- table of contents


def toc(doc, chapters):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(14)
    set_font(p.add_run('TABLE OF CONTENTS'), 14, True)

    rows = []
    for ch in chapters:
        rows.append((ch['num'], ch['title'], f"ch{ch['num']}", True))
        for num, title, _ in ch['sections']:
            rows.append((num, title, 's_' + num.replace('.', '_'), False))
    rows += [('', 'APPENDIX', 'appendix', True), ('', 'SCREENSHOTS OF THE PROJECT', 'screens', True), ('', 'REFERENCES', 'refs', True)]

    widths = [1.55, 3.75, 0.97]
    t = doc.add_table(rows=1, cols=3)
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    for i, h in enumerate(['CHAPTER NO.', 'TITLE', 'PAGE No.']):
        c = t.rows[0].cells[i]
        c.text = ''
        pp = c.paragraphs[0]
        pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pp.paragraph_format.space_before = Pt(3)
        pp.paragraph_format.space_after = Pt(3)
        set_font(pp.add_run(h), 12, True)
    for num, title, bm, major in rows:
        cells = t.add_row().cells
        for i, v in enumerate([num, title]):
            pp = cells[i].paragraphs[0]
            pp.alignment = WD_ALIGN_PARAGRAPH.CENTER if i == 0 else WD_ALIGN_PARAGRAPH.LEFT
            pp.paragraph_format.space_before = Pt(1)
            pp.paragraph_format.space_after = Pt(1)
            if i == 1 and not major:
                pp.paragraph_format.left_indent = Inches(0.25)
            set_font(pp.add_run(v), 12 if major else 11, major)
        pp = cells[2].paragraphs[0]
        pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pp.paragraph_format.space_before = Pt(1)
        pp.paragraph_format.space_after = Pt(1)
        add_field(pp, f'PAGEREF {bm} \\h', '0', 12 if major else 11, major)
    for row in t.rows:
        for i, c in enumerate(row.cells):
            c.width = Inches(widths[i])
        cs = OxmlElement('w:cantSplit'); cs.set(qn('w:val'), 'true'); row._tr.get_or_add_trPr().append(cs)


def main():
    doc = new_document()
    chapters = [CH1, CH2, CH3, CH4, CH5, CH6]
    toc(doc, chapters)
    for ch in chapters:
        chapter(doc, ch)
    appendix(doc)
    screenshots(doc)
    references(doc)
    cp = doc.core_properties
    cp.title = 'IoT Device Health and Security Monitoring Platform - Final Review Report (Part 2)'
    cp.author = 'Siddharth S'
    cp.subject = 'Final review documentation, Part 2'
    doc.save(OUT)
    print('saved', OUT)


if __name__ == '__main__':
    main()
