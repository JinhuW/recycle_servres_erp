"""Merge lane JSON + verifier verdicts into the review folder's markdown.

Run from the repo root: python3 docs/review-2026-10-31/tools/aggregate.py
"""
import json, os, glob, hashlib, collections
R = 'docs/review-2026-10-31'
L = R + '/lanes'

GROUPS = [  # (file, title, lanes)
    ('security-todo.md', 'Security and platform', ['A1']),
    ('backend-domain-todo.md', 'Backend domain: PO/SO/inventory and test suite', ['A2', 'A2t']),
    ('finance-todo.md', 'Finance', ['A3']),
    ('fleet-integrations-todo.md', 'Fleet and integrations', ['A4']),
    ('schema-todo.md', 'Schema and data', ['A5']),
    ('frontend-todo.md', 'Frontend desktop, shared components and lib', ['A6', 'A6b', 'A6c', 'A6d']),
    ('mobile-pwa-todo.md', 'Mobile and PWA', ['A7']),
    ('contracts-todo.md', 'Shared package and contracts', ['A8']),
    ('reddit-tracker-todo.md', 'Reddit tracker', ['A9', 'A9t']),
    ('facebook-tracker-todo.md', 'Facebook tracker', ['A10']),
    ('tooling-deps-todo.md', 'Tooling, CI and dependencies', ['A11']),
    ('live-resources.md', 'Live resources', ['B1', 'B2', 'B3', 'B4', 'B5']),
    ('docs-drift.md', 'Documentation drift', ['C1', 'C2', 'C3']),
]
LANE_NAMES = {
    'A1': 'Backend security/platform', 'A2': 'Backend PO/SO/inventory', 'A2t': 'Backend test suite',
    'A3': 'Backend finance', 'A4': 'Backend fleet and integrations', 'A5': 'Schema and data',
    'A6': 'Frontend desktop pages', 'A6b': 'Frontend session/cache/i18n', 'A6c': 'Frontend components',
    'A6d': 'Frontend lib and shared pages', 'A7': 'Mobile/PWA', 'A8': 'Shared and contracts',
    'A9': 'Reddit tracker', 'A9t': 'Reddit tracker tests', 'A10': 'Facebook tracker',
    'A11': 'Tooling, CI and deps', 'B1': 'Railway', 'B2': 'Cloudflare', 'B3': 'Homelab VM 10.10.10.73',
    'B4': 'Fleet and other hosts', 'B5': 'This Mac', 'C1': 'Features vs code',
    'C2': 'Agent and ops docs', 'C3': 'Project memory hygiene',
}
# Same defect reported by several lanes: secondary -> primary.
DUPES = json.load(open(R + '/tools/dupes.json'))

def load():
    lanes = {}
    for f in sorted(glob.glob(L + '/*.json')):
        b = os.path.basename(f)[:-5]
        if '.' in b:
            continue
        j = json.load(open(f))
        v = {}
        vf = f'{L}/{b}.verify.json'
        if os.path.exists(vf):
            v = {x['id']: x for x in json.load(open(vf)).get('verdicts', [])}
            j['_verify_needs_owner'] = json.load(open(vf)).get('needs_owner', [])
        for x in j['findings']:
            vv = v.get(x['id'])
            x['verdict'] = vv['verdict'] if vv else ('UNVERIFIED' if x['severity'] in ('P1', 'P2') else 'P3-unverified')
            adj = (vv or {}).get('severity_adjusted')
            x['final'] = adj if adj in ('P1', 'P2', 'P3') else x['severity']
            if vv:
                x['verify_evidence'] = vv.get('evidence', '')
                x['verify_reason'] = vv.get('reason', '')
            x['lane'] = b
            x['dupe_of'] = DUPES.get(x['id'])
        lanes[b] = j
    return lanes

def kept(x):
    return x['verdict'] != 'REJECTED' and not x['dupe_of']

def esc(s):
    return (s or '').replace('\n', ' ').strip()

def render_finding(x):
    tag = {'CONFIRMED': 'confirmed', 'PLAUSIBLE': 'plausible', 'UNVERIFIED': 'not verified', 'P3-unverified': 'P3, not verified'}[x['verdict']]
    sev = x['final'] + (f" (raised as {x['severity']})" if x['final'] != x['severity'] else '')
    out = [f"- [ ] **{x['id']} / {sev} / {tag}: {esc(x['title'])}**",
           f"  - Location: `{esc(x['location'])}`",
           f"  - Evidence: {esc(x['evidence'])}",
           f"  - Failure: {esc(x['failure_scenario'])}",
           f"  - Fix: {esc(x['proposed_fix'])}",
           f"  - Regression test: {esc(x['regression_test'])}"]
    if x.get('verify_evidence'):
        out.append(f"  - Verifier: {esc(x['verify_evidence'])}" + (f" ({esc(x['verify_reason'])})" if x.get('verify_reason') else ''))
    return '\n'.join(out)

def main():
    lanes = load()
    allf = [x for j in lanes.values() for x in j['findings']]
    k = [x for x in allf if kept(x)]
    counts = collections.Counter(x['final'] for x in k)
    summary = {'kept': len(k), 'counts': dict(counts),
               'rejected': [x['id'] for x in allf if x['verdict'] == 'REJECTED'],
               'dupes': {x['id']: x['dupe_of'] for x in allf if x['dupe_of']}}
    group_rows = []
    for fname, title, gl in GROUPS:
        items = [x for l in gl if l in lanes for x in lanes[l]['findings']]
        kk = [x for x in items if kept(x)]
        c = collections.Counter(x['final'] for x in kk)
        group_rows.append((fname, title, len(kk), c))
        lines = [f'# {title} — review 2026-10-31', '',
                 f"Lanes: {', '.join(f'{l} ({LANE_NAMES[l]})' for l in gl)}. "
                 f"{len(kk)} findings: {c.get('P1',0)} P1 / {c.get('P2',0)} P2 / {c.get('P3',0)} P3. "
                 'Severity shown is after verification; P3s were not verified.', '']
        if fname == 'live-resources.md':
            lines += [open(R + '/tools/live-snapshot.md').read(), '']
        for sev in ('P1', 'P2', 'P3'):
            s = sorted([x for x in kk if x['final'] == sev], key=lambda x: x['id'])
            if s:
                lines += [f'## {sev}', ''] + [render_finding(x) + '\n' for x in s]
        d = [x for x in items if x['dupe_of']]
        r = [x for x in items if x['verdict'] == 'REJECTED']
        if d:
            lines += ['## Reported here, tracked elsewhere', ''] + [f"- {x['id']}: {esc(x['title'])} → tracked as **{x['dupe_of']}**" for x in d] + ['']
        if r:
            lines += ['## Rejected by the verifier', ''] + [f"- {x['id']}: {esc(x['title'])}. {esc(x.get('verify_reason') or x.get('verify_evidence'))}" for x in r] + ['']
        notes = [f"- **{l}**: {esc(lanes[l].get('notes'))}" for l in gl if l in lanes and lanes[l].get('notes')]
        if notes:
            lines += ['## Limits', ''] + notes + ['']
        open(f'{R}/{fname}', 'w').write('\n'.join(lines))
    # carryover
    co = ['# Carryover from the 2026-10-13 review', '',
          'Every old ID a lane re-checked, its status at 62f53dec, and the evidence.', '',
          '| Old ID | Status | Lane | Evidence |', '| --- | --- | --- | --- |']
    for l, j in sorted(lanes.items()):
        for c in j.get('carryover', []):
            co.append(f"| {esc(c['old_id'])[:90]} | {c['status']} | {l} | {esc(c['evidence']).replace('|','/')} |")
    open(f'{R}/carryover-2026-10-13.md', 'w').write('\n'.join(co) + '\n')
    # coverage ledger
    man = json.load(open(R + '/manifest.json'))
    for x in ('A6', 'A6b'):
        man[x] = open(f'{L}/{x}.files.txt').read().split()
    reader = {}
    for l, j in lanes.items():
        for f in j.get('files_read', []):
            reader.setdefault(f, []).append(l)
    cov = ['# Coverage ledger', '',
           'Every production file in scope, the lane(s) that read it, and the SHA-256 prefix of the reviewed blob. '
           '`trackers/facebook/configs/sessions/` is out of scope by rule.', '',
           '| File | SHA-256 | Read by |', '| --- | --- | --- |']
    missing = []
    for f in sorted({f for k2, v in man.items() if k2 != 'SKIP' for f in v}):
        h = hashlib.sha256(open(f, 'rb').read()).hexdigest()[:12] if os.path.exists(f) else 'gone'
        rb = reader.get(f, [])
        if not rb:
            missing.append(f)
        cov.append(f"| `{f}` | {h} | {', '.join(sorted(rb)) or '**unread**'} |")
    open(f'{R}/coverage.md', 'w').write('\n'.join(cov) + '\n')
    summary['unread'] = missing
    summary['groups'] = [(a, b, n, dict(c)) for a, b, n, c in group_rows]
    summary['needs_owner'] = [(l, n) for l, j in lanes.items() for n in j.get('needs_owner', []) + j.get('_verify_needs_owner', [])]
    json.dump(summary, open(R + '/tools/summary.json', 'w'), indent=1)
    print(json.dumps({k3: summary[k3] for k3 in ('kept', 'counts', 'rejected')}), 'unread', len(missing))

main()
