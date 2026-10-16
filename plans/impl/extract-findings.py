import json, re
from collections import Counter

SRC = '/private/tmp/claude-501/-Users-gary-projects-instacloud-insta-oss--claude-worktrees-serverless/2ed6ce3a-af1a-4c04-b3b1-860197320fc2/tasks/wdwcsu900.output'
raw = open(SRC).read()
seg = raw[raw.find('"findings"'):]
items = re.findall(
    r'\{\s*"problem":\s*"(.*?)",\s*"evidence":\s*"(.*?)",\s*"fix":\s*"(.*?)",\s*"severity":\s*"(\w+)"\s*\}',
    seg, re.S)
out = [{"problem": a, "evidence": b, "fix": c, "severity": d} for a, b, c, d in items]
json.dump(out, open('plans/impl/gap-findings.json', 'w'), indent=1)
print("parsed", len(out), Counter(x["severity"] for x in out))
