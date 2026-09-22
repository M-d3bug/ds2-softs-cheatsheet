from pathlib import Path
idx = Path("index.html").read_text(encoding="utf-8")
gen = Path("tools/checklists_generated.html").read_text(encoding="utf-8")
start_marker = '<div class="tab-pane" id="tabChecklists">'
end_marker = '<div class="tab-pane" id="tabInformation">'
si = idx.find(start_marker)
ei = idx.find(end_marker)
print("start", si, "end", ei)
assert si != -1 and ei != -1 and ei > si
new_block = start_marker + "\n\n" + gen + "\n            </div>\n\n            "
new_idx = idx[:si] + new_block + idx[ei:]
Path("index.html").write_text(new_idx, encoding="utf-8")
print("replaced OK", len(idx), "->", len(new_idx))
