"""Draws the report's architecture, class and sequence diagrams (PNG, 200 dpi) with matplotlib."""
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'diagrams')
os.makedirs(OUT, exist_ok=True)
plt.rcParams['font.family'] = 'DejaVu Sans'

INK = '#1b2a41'
BLUE = '#dbe9ff'
GREEN = '#dff3e4'
AMBER = '#fff0cf'
PINK = '#fde2e4'
GREY = '#eef1f5'
VIOLET = '#e8e1fb'


def save(fig, name):
    fig.savefig(os.path.join(OUT, name), dpi=200, bbox_inches='tight', facecolor='white')
    plt.close(fig)
    print('saved', name)


def rbox(ax, x, y, w, h, text='', fc=GREY, ec=INK, fs=9, bold=False, lw=1.4, va='center', ha='center', color=INK):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.02,rounding_size=0.08', fc=fc, ec=ec, lw=lw))
    if text:
        tx = x + w / 2 if ha == 'center' else x + 0.12
        ty = y + h / 2 if va == 'center' else y + h - 0.12
        ax.text(tx, ty, text, ha=ha, va=va if va != 'center' else 'center', fontsize=fs, fontweight='bold' if bold else 'normal', color=color, linespacing=1.35)


def arrow(ax, p, q, text='', style='-|>', ls='-', fs=7.5, off=(0, 0.12), color=INK, lw=1.3, ha='center'):
    ax.annotate('', xy=q, xytext=p, arrowprops=dict(arrowstyle=style, color=color, lw=lw, ls=ls, shrinkA=0, shrinkB=0))
    if text:
        ax.text((p[0] + q[0]) / 2 + off[0], (p[1] + q[1]) / 2 + off[1], text, ha=ha, va='bottom', fontsize=fs, color=color)


# ======================================================================= 1. system architecture
def architecture():
    fig, ax = plt.subplots(figsize=(11, 8.2))
    ax.set_xlim(0, 22); ax.set_ylim(0, 16.4); ax.axis('off')

    # actors
    rbox(ax, 0.4, 14.2, 4.6, 1.8, 'Maintenance engineer /\nAdministrator\n(web browser)', fc=GREY, fs=9)
    rbox(ax, 8.6, 14.2, 4.8, 1.8, 'IoT devices and\nbuilt-in simulator\n(HTTP + device key)', fc=GREY, fs=9)
    rbox(ax, 17.0, 14.2, 4.6, 1.8, 'Webhook receivers\n(Slack / Discord /\nany HTTPS endpoint)', fc=GREY, fs=9)

    # presentation
    rbox(ax, 0.4, 10.9, 9.2, 2.2, '', fc=BLUE)
    ax.text(5.0, 12.7, 'PRESENTATION LAYER', ha='center', fontsize=9, fontweight='bold')
    ax.text(5.0, 11.75, 'React + TypeScript (Vite)  |  TanStack Query  |  Recharts\nNginx serves the app and proxies /api  |  live updates over SSE', ha='center', fontsize=8.5, va='center')

    # api
    rbox(ax, 0.4, 4.9, 21.2, 5.2, '', fc=GREEN)
    ax.text(11.0, 9.7, 'APPLICATION LAYER  -  Node.js + Express.js (TypeScript) REST API', ha='center', fontsize=9, fontweight='bold')
    names = [
        ('Authentication\n& users (JWT)', 7.6), ('Device &\ntelemetry ingest', 7.6), ('Rule engine\n& alerts', 7.6), ('Anomaly\nprediction (ML)', 7.6), ('Firmware &\nincidents', 7.6), ('Webhook\nnotifications', 7.6),
        ('Reports\n(CSV / PDF)', 5.3), ('Knowledge base\ningestion', 5.3), ('Hybrid retrieval\n+ access control', 5.3), ('AI assistant\n(tools + RAG)', 5.3), ('Audit log', 5.3), ('Event bus\n(SSE)', 5.3),
    ]
    for i, (t, y) in enumerate(names):
        rbox(ax, 0.8 + (i % 6) * 3.45, y, 3.1, 1.7, t, fc='white', fs=8)

    # data
    rbox(ax, 0.4, 0.4, 6.4, 3.3, '', fc=AMBER)
    ax.text(3.6, 3.25, 'MongoDB 7', ha='center', fontsize=9.5, fontweight='bold')
    ax.text(3.6, 1.9, 'users, devices, telemetry (TTL)\nalerts, rules, firmware, incidents\nmaintenance, predictions\nmodel versions, webhooks, audit', ha='center', va='center', fontsize=8)
    rbox(ax, 7.4, 0.4, 6.4, 3.3, '', fc=AMBER)
    ax.text(10.6, 3.25, 'PostgreSQL 16 + pgvector', ha='center', fontsize=9.5, fontweight='bold')
    ax.text(10.6, 1.9, 'documents and text chunks\nembeddings (HNSW) + full-text index\nchat conversations and messages\naccess rules applied in SQL', ha='center', va='center', fontsize=8)
    rbox(ax, 14.4, 0.4, 3.4, 3.3, '', fc=AMBER)
    ax.text(16.1, 3.25, 'Redis 7', ha='center', fontsize=9.5, fontweight='bold')
    ax.text(16.1, 1.9, 'heartbeat TTL\nlatest + window\ncaches, limits\npub/sub', ha='center', va='center', fontsize=8)
    rbox(ax, 18.4, 0.4, 3.2, 3.3, '', fc=VIOLET)
    ax.text(20.0, 3.25, 'Ollama', ha='center', fontsize=9.5, fontweight='bold')
    ax.text(20.0, 1.9, 'local chat model\nlocal embedding\nmodel\n(data stays on\nthe machine)', ha='center', va='center', fontsize=8)

    # arrows
    arrow(ax, (2.7, 14.2), (2.7, 13.1), 'HTTPS', off=(0.55, -0.1))
    arrow(ax, (5.0, 10.9), (5.0, 10.1), 'REST + JWT / SSE', off=(1.6, -0.15))
    arrow(ax, (11.0, 14.2), (11.0, 10.1), 'POST /api/telemetry', off=(1.6, 1.0))
    arrow(ax, (19.3, 10.1), (19.3, 14.2), 'signed POST', off=(0.2, 1.1), ha='center')
    for x in (3.6, 10.6, 16.1):
        arrow(ax, (x, 4.9), (x, 3.7), style='<|-|>')
    arrow(ax, (20.0, 4.9), (20.0, 3.7), style='<|-|>')
    ax.text(21.65, 4.15, '', fontsize=7)
    save(fig, 'architecture.png')


# ======================================================================= 2. class diagrams
# 1 data unit = 0.2 inch; text sizes are chosen so box widths always fit their text.
U = 0.2
CHAR = 0.0765 / U       # one monospace character at 9 pt, in data units
STEP = 0.78             # line height
HEAD = 1.0


class Cls:
    def __init__(self, name, attrs):
        self.name, self.attrs = name, attrs
        self.w = max(max(len(a) for a in attrs) * CHAR + 1.0, len(name) * 0.62 + 1.2)
        self.h = HEAD + STEP * len(attrs) + 0.35
        self.x = self.y = 0.0

    def at(self, x, y):
        self.x, self.y = x, y
        return self

    def draw(self, ax):
        ax.add_patch(Rectangle((self.x, self.y), self.w, self.h, fc='white', ec=INK, lw=1.4))
        ax.add_patch(Rectangle((self.x, self.y + self.h - HEAD), self.w, HEAD, fc='#c9dcf5', ec=INK, lw=1.4))
        ax.text(self.x + self.w / 2, self.y + self.h - HEAD / 2, self.name, ha='center', va='center', fontsize=10.5, fontweight='bold')
        for i, a in enumerate(self.attrs):
            ax.text(self.x + 0.5, self.y + self.h - HEAD - 0.2 - STEP * (i + 0.5), a, ha='left', va='center', fontsize=9, family='DejaVu Sans Mono')

    def anchor(self, side, frac=0.5):
        return {'l': (self.x, self.y + self.h * frac), 'r': (self.x + self.w, self.y + self.h * frac),
                't': (self.x + self.w * frac, self.y + self.h), 'b': (self.x + self.w * frac, self.y)}[side]


def canvas(w, h):
    fig, ax = plt.subplots(figsize=(w * U, h * U))
    fig.subplots_adjust(0, 0, 1, 1)   # the axes fill the figure, so 1 data unit is exactly U inches
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.axis('off')
    return fig, ax


def mult(ax, pt, text, dx, dy):
    ax.text(pt[0] + dx, pt[1] + dy, text, fontsize=11, ha='center', va='center', color='#9c1c1c', fontweight='bold')


def link(ax, p, q, ma='', mb='', label='', da=(0.6, 0.6), db=(-0.6, 0.6)):
    ax.plot([p[0], q[0]], [p[1], q[1]], color=INK, lw=1.4)
    if ma:
        mult(ax, p, ma, *da)
    if mb:
        mult(ax, q, mb, *db)
    if label:
        ax.text((p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + 0.2, label, fontsize=9, ha='center', va='bottom', color='#333', style='italic', bbox=dict(fc='white', ec='none', pad=1.2))


def bus(ax, src, targets, xb, ma='1', mb='*'):
    """src right side -> vertical bus at xb -> each target's left side (orthogonal connectors)."""
    sp = src.anchor('r')
    ys = [t.anchor('l')[1] for t in targets]
    ax.plot([sp[0], xb], [sp[1], sp[1]], color=INK, lw=1.4)
    ax.plot([xb, xb], [min(ys + [sp[1]]), max(ys + [sp[1]])], color=INK, lw=1.4)
    mult(ax, sp, ma, 0.6, 0.6)
    for t in targets:
        q = t.anchor('l')
        ax.plot([xb, q[0]], [q[1], q[1]], color=INK, lw=1.4)
        mult(ax, q, mb, -0.6, 0.6)


def class_devices():
    dtype = Cls('DeviceType', ['id : int', 'name : string (unique)', 'metrics : MetricKey[]', 'baselines : map'])
    rule = Cls('AlertRule', ['id : int', 'metric : MetricKey', 'operator : > | <', 'threshold : number', 'severity : warning|critical', 'deviceType : string|null', 'enabled : boolean'])
    device = Cls('Device', ['id : UUID', 'assetNo : int (unique)', 'name, type, location', 'firmwareVersion : string', 'status : online|degraded|offline', 'active, simulated : boolean', 'apiKeyHash : SHA-256', 'lastSeen : Date'])
    tele = Cls('Telemetry', ['deviceId : UUID', 'ts : Date (TTL index)', 'temperature, cpu, memory', 'battery, signal', 'vibration, pressure, current'])
    alert = Cls('Alert', ['id : int', 'deviceId : UUID', 'type : threshold|heartbeat|predictive', 'severity, metric, message', 'status : open|acknowledged|resolved', 'createdAt, resolvedAt : Date'])
    maint = Cls('MaintenanceRecord', ['id : int', 'deviceId : UUID', 'kind : inspection|repair|...', 'summary, details : string', 'performedByName : string', 'performedAt : Date'])
    c1 = max(dtype.w, rule.w)
    right = [tele, alert, maint]
    c3 = max(c.w for c in right)
    gap = 2.2
    total = sum(c.h for c in right) + gap * 2
    x2 = c1 + 6.0
    x3 = x2 + device.w + 8.0
    W = x3 + c3 + 1.0
    H = total + 1.0
    y = total + 0.5
    for c in right:
        y -= c.h
        c.at(x3, y)
        c.w = c3
        y -= gap
    mid = H / 2
    device.at(x2, mid - device.h / 2)
    dtype.at(0.3, mid + 2.5)
    rule.at(0.3, mid - 2.5 - rule.h)
    fig, ax = canvas(W, H)
    for c in (dtype, rule, device, tele, alert, maint):
        c.draw(ax)
    link(ax, dtype.anchor('b'), rule.anchor('t'), '1', '*', 'limits', (0.7, -0.7), (0.7, 0.7))
    link(ax, dtype.anchor('r', 0.4), device.anchor('l', 0.85), '1', '*', 'has', (0.6, 0.6), (-0.6, 0.6))
    bus(ax, device, right, x3 - 4.0)
    save(fig, 'class_devices.png')


def class_prediction():
    device = Cls('Device', ['id : UUID', 'name, type, location', 'firmwareVersion : string'])
    pred = Cls('PredictionSnapshot', ['id : int', 'deviceId, metric', 'probability : 0..1', 'level : low|elevated|high', 'secondsToBreach : number', 'modelVersion, modelSource', 'explanation : object'])
    mv = Cls('ModelVersion', ['id : int', 'scope : "global" | type', 'version : int', 'evaluation : AUC, F1, ...', 'activated, isActive : boolean', 'reason, trainedBy : string'])
    fw = Cls('FirmwareUpdate', ['id : int', 'deviceId : UUID', 'fromVersion, toVersion', 'status, progress : int'])
    inc = Cls('SecurityIncident', ['id : int', 'deviceId : UUID | null', 'category, severity', 'description, status'])
    hook = Cls('Webhook', ['id : int', 'name, url', 'secret : HMAC key', 'events : string[]', 'enabled : boolean'])
    right = [pred, fw, inc]
    c3 = max(c.w for c in right)
    gap = 2.2
    total = sum(c.h for c in right) + gap * 2
    x2 = device.w + 9.0
    x4 = x2 + c3 + 6.0
    W = x4 + max(mv.w, hook.w) + 1.0
    H = total + 1.0
    y = total + 0.5
    for c in right:
        y -= c.h
        c.at(x2, y)
        c.w = c3
        y -= gap
    device.at(0.3, H / 2 - device.h / 2)
    mv.at(x4, pred.y + pred.h / 2 - mv.h / 2)
    hook.at(x4, inc.y)
    fig, ax = canvas(W, H)
    for c in (device, pred, fw, inc, mv, hook):
        c.draw(ax)
    bus(ax, device, right, x2 - 4.5)
    link(ax, pred.anchor('r'), mv.anchor('l'), '*', '1', 'scored by', (0.6, 0.6), (-0.6, 0.6))
    link(ax, inc.anchor('r'), hook.anchor('l'), '', '*', 'notifies', (0.6, 0.6), (-0.6, 0.6))
    save(fig, 'class_prediction.png')


def class_knowledge():
    user = Cls('User  (MongoDB)', ['id : UUID', 'email, name', 'role : admin | viewer'])
    doc = Cls('KbDocument', ['id : UUID', 'ownerId : UUID | null', 'source : upload | system', 'title, originalName, sha256', 'visibility : private | shared', 'status : queued|processing|ready|failed', 'chunkCount, pages : int'])
    chunk = Cls('KbChunk', ['id : bigint', 'documentId : UUID', 'content, page, section', 'embedding : vector(1024)', 'tsv : tsvector'])
    conv = Cls('Conversation', ['id : UUID', 'userId : UUID (owner)', 'title : string', 'deviceId : UUID | null'])
    msg = Cls('Message', ['id : bigint', 'conversationId : UUID', 'role : user | assistant', 'content : text', 'sources, toolCalls : JSON', 'model, latencyMs, error'])
    tool = Cls('Tool (read-only)', ['name : fleet_status|top_risk|..', 'run(args) : ToolResult', 'timeout 8 s, <= 10 rows'])
    prov = Cls('LLMProvider', ['health()', 'embed(texts) : vectors', 'chat(messages) : stream'])
    c1 = max(user.w, conv.w, tool.w)
    c2 = max(doc.w, msg.w, prov.w)
    g = 8.0
    for c in (user, conv, tool):
        c.w = c1
    for c in (doc, msg, prov):
        c.w = c2
    W = c1 + g + c2 + g + chunk.w + 1.0
    r3 = 0.5
    r2 = r3 + tool.h + 5.0
    r1 = r2 + conv.h + 5.0
    H = r1 + user.h + 1.0
    user.at(0.3, r1)
    doc.at(c1 + g, r1 - 3.0)
    chunk.at(c1 + g + c2 + g, r1 - 1.0)
    conv.at(0.3, r2)
    msg.at(c1 + g, r2 - 2.0)
    tool.at(0.3, r3)
    prov.at(c1 + g, r3)
    fig, ax = canvas(W, H)
    for c in (user, doc, chunk, conv, msg, tool, prov):
        c.draw(ax)
    link(ax, user.anchor('r', 0.5), doc.anchor('l', 0.8), '1', '*', 'owns', (0.6, 0.6), (-0.6, 0.6))
    link(ax, doc.anchor('r', 0.5), chunk.anchor('l', 0.5), '1', '*', 'split into', (0.6, 0.6), (-0.6, 0.6))
    link(ax, user.anchor('b', 0.3), conv.anchor('t', 0.3), '1', '*', 'starts', (0.7, -0.7), (0.7, 0.7))
    link(ax, conv.anchor('r', 0.5), msg.anchor('l', 0.7), '1', '*', 'contains', (0.6, 0.6), (-0.6, 0.6))
    link(ax, conv.anchor('b', 0.3), tool.anchor('t', 0.3), '', '*', 'uses', (0.7, -0.7), (0.7, 0.7))
    link(ax, tool.anchor('r', 0.5), prov.anchor('l', 0.5), '', '', 'answers via', (0.6, 0.6), (-0.6, 0.6))
    save(fig, 'class_knowledge.png')


# ======================================================================= 3. sequence diagrams
def sequence(name, title, actors, steps, width, height, spacing):
    fig, ax = plt.subplots(figsize=(width, height))
    n = len(actors)
    xs = [i * spacing + 1.4 for i in range(n)]
    top = len(steps) * 1.0 + 3.0
    ax.set_xlim(0, xs[-1] + 1.8); ax.set_ylim(0, top + 1.2); ax.axis('off')
    ax.text(xs[-1] / 2 + 0.7, top + 0.8, title, ha='center', fontsize=11, fontweight='bold')
    for x, (label, fc) in zip(xs, actors):
        rbox(ax, x - 1.15, top - 0.9, 2.3, 0.95, label, fc=fc, fs=8, bold=True)
        ax.plot([x, x], [0.4, top - 0.9], color='#7b8794', lw=1, ls=(0, (4, 3)))
    y = top - 1.6
    for a, b, text, kind in steps:
        xa, xb = xs[a], xs[b]
        if a == b:
            ax.plot([xa, xa + 0.7, xa + 0.7, xa + 0.05], [y + 0.15, y + 0.15, y - 0.2, y - 0.2], color=INK, lw=1.2)
            ax.annotate('', xy=(xa, y - 0.2), xytext=(xa + 0.2, y - 0.2), arrowprops=dict(arrowstyle='-|>', color=INK, lw=1.2))
            ax.text(xa + 0.85, y - 0.02, text, fontsize=7.4, va='center', ha='left')
        else:
            ls = '--' if kind == 'ret' else '-'
            arrow(ax, (xa, y), (xb, y), '', ls=ls, lw=1.3)
            ax.text((xa + xb) / 2, y + 0.1, text, ha='center', va='bottom', fontsize=7.4, bbox=dict(fc='white', ec='none', pad=0.8))
        y -= 1.0
    save(fig, name)


def sequence_ingest():
    actors = [('IoT device', GREY), ('Express API', GREEN), ('MongoDB', AMBER), ('Redis', AMBER), ('Predictor', VIOLET), ('Dashboard', BLUE)]
    steps = [
        (0, 1, 'POST /api/telemetry  (x-api-key, readings)', ''),
        (1, 2, 'find device by key hash', ''),
        (2, 1, 'device (active?)', 'ret'),
        (1, 2, 'insert reading', ''),
        (1, 3, 'update latest value, window, heartbeat TTL', ''),
        (1, 1, 'evaluate threshold rules', ''),
        (1, 2, 'open / refresh / resolve alert', ''),
        (1, 4, 'score the last 20 readings', ''),
        (4, 1, 'probability, ETA, explanation', 'ret'),
        (1, 2, 'store prediction snapshot', ''),
        (1, 3, 'publish event (pub/sub)', ''),
        (3, 5, 'SSE push: refresh data', ''),
        (1, 0, '202 Accepted', 'ret'),
    ]
    sequence('sequence_ingest.png', 'Telemetry ingestion, alerting and prediction', actors, steps, 11, 7.2, 3.3)


def sequence_assistant():
    actors = [('User', GREY), ('React UI', BLUE), ('Express API', GREEN), ('MongoDB', AMBER), ('PostgreSQL\n+ pgvector', AMBER), ('Ollama', VIOLET)]
    steps = [
        (0, 1, 'asks a question', ''),
        (1, 2, 'POST /messages (JWT)', ''),
        (2, 4, 'save the question', ''),
        (2, 2, 'planner selects read-only tools', ''),
        (2, 3, 'run tools: live fleet data', ''),
        (2, 5, 'embed the question', ''),
        (2, 4, 'hybrid search (vector + keyword, owner / shared filter)', ''),
        (2, 2, 'build prompt: sources in marked blocks', ''),
        (2, 5, 'stream answer from the model', ''),
        (2, 1, 'SSE tokens, sources', 'ret'),
        (2, 2, 'verify citations against sources', ''),
        (2, 4, 'save answer, sources, tool calls', ''),
        (2, 3, 'write audit entry (no message text)', ''),
        (1, 0, 'answer with [S1] / [D1] citations', 'ret'),
    ]
    sequence('sequence_assistant.png', 'AI Maintenance Assistant: answering one question', actors, steps, 11, 7.6, 3.3)


if __name__ == '__main__':
    architecture()
    class_devices()
    class_prediction()
    class_knowledge()
    sequence_ingest()
    sequence_assistant()
