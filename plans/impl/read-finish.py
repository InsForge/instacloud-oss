import json

SRC = '/Users/gary/.clauth/profiles/tony.chang2@insforge.dev/runtime-5212-0/projects/-Users-gary/2ed6ce3a-af1a-4c04-b3b1-860197320fc2/subagents/workflows/wf_78ce09a4-d28/journal.jsonl'

for line in open(SRC):
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get('type') != 'result':
        continue
    r = d.get('result') or d.get('value') or d.get('output')
    if not isinstance(r, dict):
        continue
    if 'passed' in r:
        print('=== DOCKER SUITES')
        print('passed:', len(r['passed']))
        for s in r['passed']:
            print('  PASS', s[:150])
        print('failed:', len(r['failed']))
        for s in r['failed']:
            print('  FAIL', s.get('suite'), '::', s.get('diagnosis', '')[:400])
        print('skipped:', r.get('skipped'))
        print('real defects found:', len(r.get('realDefectsFound') or []))
        for s in (r.get('realDefectsFound') or []):
            print('   *', s[:300])
    if 'steps' in r:
        print('=== SMOKE')
        for s in r['steps']:
            print(' ', s['result'].upper(), s['step'][:110], '|', s['evidence'][:220])
        print('VERDICT:', r.get('verdict', '')[:2500])
        print('fixes:', len(r.get('fixes') or []))
