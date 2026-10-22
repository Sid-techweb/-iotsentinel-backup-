import os, re
HERE = os.path.dirname(os.path.abspath(__file__))


def edit(name, pairs):
    p = os.path.join(HERE, name)
    s = open(p, encoding='utf8').read()
    for a, b in pairs:
        assert a in s, (name, a[:70])
        s = s.replace(a, b, 1)
    open(p, 'w', encoding='utf8', newline='').write(s)
    print('patched', name)


edit('build_report.py', [
    # --- fonts: Times New Roman everywhere, Consolas 10 pt for code
    ("set_font(paragraph.add_run(part[1:-1]), size - 1.5, bold, italic, name='Courier New')", "set_font(paragraph.add_run(part[1:-1]), 10, bold, italic, name='Consolas')"),
    ("def code_block(doc, text, cap=None, size=8.5):\n", "def code_block(doc, text, cap=None, size=10):\n    size = 10  # style guide: Consolas, 10 pt, left aligned\n"),
    ("set_font(p.add_run(line if line else ' '), size, name='Courier New')", "set_font(p.add_run(line if line else ' '), size, name='Consolas')"),
    # --- main titles 16 pt
    ("""set_font(p.add_run(f"CHAPTER {ch['num']}"), 14, True, color='000000')""", """set_font(p.add_run(f"CHAPTER {ch['num']}"), 16, True, color='000000')"""),
    ("set_font(t.add_run(ch['title']), 14, True)", "set_font(t.add_run(ch['title']), 16, True)"),
    # --- sub-headings 12 pt bold
    ("set_font(p.add_run(text), 11.5, True)", "set_font(p.add_run(text), 12, True)"),
    # --- references at 1.5 spacing
    ("body(doc, f'[{i}]  {r}', after=6, spacing=1.15)", "body(doc, f'[{i}]  {r}', after=3, spacing=1.5)"),
    # --- appendix: leaner excerpts
    ("""    cf('Indexes created at start-up (excerpt, backend/src/mongo.ts)', 'backend/src/mongo.ts', "col('users').createIndex", "col('telemetry').createIndex({ deviceId: 1, ts: -1 })", 0)\n""", ""),
    ("""    cf('Query used by both (backend/src/services/deviceQueries.ts)', 'backend/src/services/deviceQueries.ts', 'export async function listDevices', None)\n""", ""),
    ("    for n, (title, req_line, body_json, status, resp) in enumerate(examples, 1):", "    keep = ('Sign in', 'Create a device', 'Send telemetry (device key)', 'Update a device', 'Validation error')\n    for n, (title, req_line, body_json, status, resp) in enumerate([e for e in examples if e[0] in keep], 1):"),
])

# project tree and extra variables: shorter
s = open(os.path.join(HERE, 'build_report.py'), encoding='utf8').read()
i = s.index('STRUCTURE = """'); j = s.index('"""', i + 20) + 3
s = s[:i] + '''STRUCTURE = """iot-sentinel/
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
`-- docker-compose.yml, .env.example, README.md"""''' + s[j:]
a = s.index('    code_block(doc, """MONGO_URL=')
b2 = s.index('ASSISTANT_MSG_PER_MIN=20""")') + len('ASSISTANT_MSG_PER_MIN=20""")')
s = s[:a] + '''    code_block(doc, """MONGO_URL=mongodb://iot:iot@localhost:27017/iotmonitor?authSource=admin
DATABASE_URL=postgres://iot:iot@localhost:5433/iotmonitor
REDIS_URL=redis://localhost:6379
TELEMETRY_RETENTION_DAYS=7
OLLAMA_URL=http://localhost:11434
LLM_MODEL=qwen2.5:7b
EMBED_MODEL=qwen3-embedding:0.6b
MAX_UPLOAD_MB=10""")''' + s[b2:]
# screenshots: fewer, cropped to one readable piece each, two per page
s = s.replace("    ('02-register', 'Account registration (the first account becomes the administrator)'),\n", "")
s = s.replace("    ('09-machine-types', 'Machine types and their models'),\n", "")
s = s.replace("    ('18-users', 'User management'),\n", "")
i = s.index('def split_tall'); j = s.index('def screenshots')
s = s[:i] + '''def crop_top(path, ratio=0.66):
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


''' + s[j:]
i = s.index('        parts = split_tall(f)'); j = s.index('def screenshots', i) if False else s.index("REFERENCES = [")
s = s[:i] + "        part, cropped = crop_top(f)\n        picture(doc, part, f'Figure {n}: {title}' + (' (upper part of the page)' if cropped else ''), 5.5, max_h_in=4.0)\n\n\n" + s[j:]
# reference list: keep the sources cited in the text plus the infrastructure documentation
for key in ('"OpenJS Foundation', '"Meta Platforms', '"Microsoft, \\"Playwright'):
    pass
lines = s.split('\n')
lines = [l for l in lines if not (l.strip().startswith('"OpenJS Foundation') or l.strip().startswith('"Meta Platforms, Inc.') or l.strip().startswith('"Microsoft, \\"Playwright'))]
s = '\n'.join(lines)
open(os.path.join(HERE, 'build_report.py'), 'w', encoding='utf8', newline='').write(s)
print('patched build_report.py (2)')

# 5.2: drop three of the longer listings (their explanations stay)
p = os.path.join(HERE, 'content_ch4_6.py')
c = open(p, encoding='utf8').read()
for marker in ("('codefile', 'backend/src/services/sweeper.ts'", "('codefile', 'backend/src/services/ai/rag.ts', 'export function sanitizeSourceText'", "('codefile', 'backend/src/routes/assistant.ts'"):
    i = c.index(marker)
    j = c.index('\n', i)
    c = c[:i] + c[j + 1:]
open(p, 'w', encoding='utf8', newline='').write(c)
print('patched content_ch4_6.py')
