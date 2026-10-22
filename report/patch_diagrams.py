import os
here = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(here, 'make_diagrams.py')
s = open(p, encoding='utf8').read()
new = open(os.path.join(here, 'classes_new.txt'), encoding='utf8').read()
i = s.index('# ======================================================================= 2. class diagrams')
j = s.index('# ======================================================================= 3. sequence diagrams')
s = s[:i] + new + s[j:]
old = """    mods = [
        ('Authentication\\n& users (JWT)', 0.8, 7.6), ('Device &\\ntelemetry ingest', 4.4, 7.6), ('Rule engine\\n& alerts', 8.0, 7.6), ('Anomaly\\nprediction (ML)', 11.6, 7.6),
        ('Firmware &\\nincidents', 15.2, 7.6), ('Webhook\\nnotifications', 18.4, 7.6),
        ('Reports\\n(CSV / PDF)', 0.8, 5.3), ('Knowledge base\\ningestion', 4.4, 5.3), ('Hybrid retrieval\\n+ access control', 8.0, 5.3), ('AI assistant\\n(tools + RAG)', 11.6, 5.3),
        ('Audit log', 15.2, 5.3), ('Event bus\\n(SSE)', 18.4, 5.3),
    ]
    for t, x, y in mods:
        rbox(ax, x, y, 3.2, 1.7, t, fc='white', fs=8)"""
assert old in s
newmods = """    names = [
        ('Authentication\\n& users (JWT)', 7.6), ('Device &\\ntelemetry ingest', 7.6), ('Rule engine\\n& alerts', 7.6), ('Anomaly\\nprediction (ML)', 7.6), ('Firmware &\\nincidents', 7.6), ('Webhook\\nnotifications', 7.6),
        ('Reports\\n(CSV / PDF)', 5.3), ('Knowledge base\\ningestion', 5.3), ('Hybrid retrieval\\n+ access control', 5.3), ('AI assistant\\n(tools + RAG)', 5.3), ('Audit log', 5.3), ('Event bus\\n(SSE)', 5.3),
    ]
    for i, (t, y) in enumerate(names):
        rbox(ax, 0.8 + (i % 6) * 3.45, y, 3.1, 1.7, t, fc='white', fs=8)"""
s = s.replace(old, newmods)
# sequence labels get a white background so they stay readable over lifelines
s = s.replace("ax.text((xa + xb) / 2, y + 0.1, text, ha='center', va='bottom', fontsize=7.4)", "ax.text((xa + xb) / 2, y + 0.1, text, ha='center', va='bottom', fontsize=7.4, bbox=dict(fc='white', ec='none', pad=0.8))")
open(p, 'w', encoding='utf8', newline='').write(s)
print('patched')
