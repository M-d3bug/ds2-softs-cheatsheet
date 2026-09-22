from pathlib import Path
import re
html = Path("index.html").read_text(encoding="utf-8")
# 1. scripts
for s in ["js/jstorage.js", "js/store.js", "js/main.js", "js/sync.js"]:
    assert s in html, f"missing script {s}"
    assert Path(s).exists(), f"file missing {s}"
print("scripts OK")
# 2. no rawgit / UA analytics
assert "rawgit" not in html, "rawgit still referenced"
assert "UA-35576868" not in html, "old GA still present"
print("cdn cleanup OK")
# 3. checklist ids contiguous 1..N per section 1..9
ids = re.findall(r'data-id="checklist_(\d+)_(\d+)"', html)
from collections import Counter, defaultdict
by = defaultdict(list)
for sec, idx in ids:
    by[int(sec)].append(int(idx))
for sec in range(1, 10):
    assert sec in by, f"section {sec} missing"
    vals = sorted(by[sec])
    assert vals == list(range(1, len(vals)+1)), f"section {sec} non-contiguous: {vals[:10]}... len={len(vals)}"
    print(f"checklist_{sec}: {len(vals)} contiguous OK")
# 4. nav + totals spans present
for sec in range(1, 10):
    assert f'id="checklist_nav_totals_{sec}"' in html, f"nav {sec} missing"
    assert f'id="checklist_totals_{sec}"' in html, f"totals {sec} missing"
assert 'id="checklist_overall_total"' in html
print("totals spans OK")
# 5. sync UI present
for token in ["syncStatus", "syncNow", "syncSettings", "syncModal", "syncToken", "syncSave", "syncExport", "syncImportFile"]:
    assert token in html, f"sync UI {token} missing"
print("sync UI OK")
# 6. no duplicate data-id
all_ids = re.findall(r'data-id="(checklist_\d+_\d+)"', html)
assert len(all_ids) == len(set(all_ids)), "duplicate data-id found"
print(f"no duplicates, total checklist items: {len(all_ids)}")
# 7. playthrough untouched?
assert 'id="playthrough_overall_total"' in html
print("playthrough OK")
print("ALL CHECKS PASSED")
