#!/usr/bin/env python3
"""Build Checklists tab HTML from SOTFS Achievement Checklist xlsx.

Stdlib only (no openpyxl). Reads the xlsx next to the repo and emits
tools/checklists_generated.html + a stats report.

Mapping (skips Supreme Weapon per user request):
  sheet1 Achievements      -> checklist_6_*
  sheet2 Gesture Maestro   -> checklist_5_* (overwrite existing)
  sheet3 Master of Sorcery -> checklist_1_* (overwrite existing)
  sheet4 Master of Miracles-> checklist_2_* (overwrite existing)
  sheet5 Master of Pyro    -> checklist_4_* (overwrite existing, keeps legacy numbering)
  sheet6 Master of Hexes   -> checklist_3_* (overwrite existing, keeps legacy numbering)
  sheet8 Gathering Exiles  -> checklist_7_*
  sheet9 Curious Map       -> checklist_8_*
  sheet10 Lucatiel         -> checklist_9_*
"""
import html
import pathlib
import re
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
XLSX_CANDIDATES = [
    pathlib.Path(r"C:\Users\Z\Desktop\ds2\SOTFS Achievement Checklist (Clean).xlsx"),
    REPO.parent / "SOTFS Achievement Checklist (Clean).xlsx",
]


def find_xlsx():
    for p in XLSX_CANDIDATES:
        if p.exists():
            return p
    raise FileNotFoundError(f"xlsx not found, tried: {XLSX_CANDIDATES}")


def load_rows(xlsx_path):
    z = zipfile.ZipFile(xlsx_path)
    ss_root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    strings = [
        "".join(n.text or "" for n in si.findall(".//m:t", NS))
        for si in ss_root.findall("m:si", NS)
    ]

    def cell_text(c):
        t = c.get("t")
        v = c.find("m:v", NS)
        vv = v.text if v is not None else ""
        if t == "s" and vv != "":
            try:
                return strings[int(float(vv))]
            except Exception:
                return vv
        # inline string fallback
        is_el = c.find("m:is", NS)
        if is_el is not None:
            return "".join(n.text or "" for n in is_el.findall(".//m:t", NS))
        return vv or ""

    sheets = {}
    for i in range(1, 11):
        try:
            data = z.read(f"xl/worksheets/sheet{i}.xml")
        except KeyError:
            continue
        root = ET.fromstring(data)
        rows = []
        for r in root.findall(".//m:row", NS):
            vals = [cell_text(c).strip() for c in r.findall("m:c", NS)]
            # drop trailing empties but keep column positions for first cols
            while vals and vals[-1] == "":
                vals.pop()
            if any(vals):
                rows.append(vals)
        sheets[i] = rows
    return sheets


def slug(name):
    s = name.lower().strip()
    s = s.replace("'", "").replace("’", "")
    s = s.replace("!", "").replace(".", "").replace(":", "").replace(",", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def wiki(name):
    return f"http://darksouls2.wikidot.com/{slug(name)}"


def fmt_cost(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        n = float(raw.replace(",", ""))
        if n.is_integer():
            return f"{int(n):,} souls"
        return f"{raw} souls"
    except ValueError:
        return raw


def esc(s):
    return html.escape(s, quote=False)


def li(data_id, inner_html):
    return f'                    <li data-id="{data_id}">{inner_html}</li>'


def spell_item(name, location, cost, is_dlc=False):
    parts = [f'<a href="{wiki(name)}">{esc(name)}</a>']
    desc = []
    if location:
        desc.append(esc(location))
    if cost:
        desc.append(f"for {esc(fmt_cost(cost))}")
    text = " - ".join(["".join(parts), ", ".join(desc)]) if desc else parts[0]
    # hmm above joins wrong; rebuild:
    text = parts[0]
    if location or cost:
        text += " - "
        bits = []
        if location:
            bits.append(esc(location))
        if cost:
            bits.append(f"for {esc(fmt_cost(cost))}")
        text += " ".join(bits) if location and cost else ", ".join(bits)
    if is_dlc:
        text = "<b>DLC</b> " + text
    return text


def build():
    xlsx = find_xlsx()
    sheets = load_rows(xlsx)
    out_sections = []
    stats = []

    # --- sheet3 sorcery -> checklist 1
    rows = sheets[3][1:]  # skip header
    items = [r for r in rows if r and r[0] and r[0] != "DLC Sorceries"]
    dlc_names = {"Focus Souls", "Soul Flash"}
    sec = []
    for idx, r in enumerate(items, start=1):
        name = r[0]
        loc = r[2] if len(r) > 2 else ""
        cost = r[3] if len(r) > 3 else ""
        sec.append(li(f"checklist_1_{idx}", spell_item(name, loc, cost, name in dlc_names)))
    out_sections.append(("Master_Of_Sorcery", "Master of Sorcery", "sorceries", 1, sec))
    stats.append(f"sorcery checklist_1: {len(sec)} items")

    # --- sheet4 miracles -> checklist 2
    rows = sheets[4][1:]
    items = [r for r in rows if r and r[0] and r[0] != "DLC Miracles"]
    dlc_names = {"Denial", "Splintering Lightning Spear"}
    sec = []
    for idx, r in enumerate(items, start=1):
        name = r[0]
        loc = r[2] if len(r) > 2 else ""
        cost = r[3] if len(r) > 3 else ""
        sec.append(li(f"checklist_2_{idx}", spell_item(name, loc, cost, name in dlc_names)))
    out_sections.append(("Master_Of_Miracles", "Master of Miracles", "miracles", 2, sec))
    stats.append(f"miracles checklist_2: {len(sec)} items")

    # --- sheet6 hexes -> checklist 3 (legacy numbering kept)
    rows = sheets[6][1:]
    items = [r for r in rows if r and r[0] and r[0] != "DLC Hexes"]
    dlc_names = {"Promised Walk of Peace", "Dark Greatsword", "Recollection", "Dark Dance"}
    sec = []
    for idx, r in enumerate(items, start=1):
        name = r[0]
        loc = r[2] if len(r) > 2 else ""
        cost = r[3] if len(r) > 3 else ""
        sec.append(li(f"checklist_3_{idx}", spell_item(name, loc, cost, name in dlc_names)))
    out_sections.append(("Master_Of_Hexes", "Master of Hexes", "hexes", 3, sec))
    stats.append(f"hexes checklist_3: {len(sec)} items")

    # --- sheet5 pyro -> checklist 4 (legacy numbering kept)
    rows = sheets[5][1:]
    items = [r for r in rows if r and r[0] and r[0] != "DLC Pyromancies"]
    dlc_names = {"Outcry", "Dance of Fire", "Fire Snake"}
    sec = []
    for idx, r in enumerate(items, start=1):
        name = r[0]
        loc = r[2] if len(r) > 2 else ""
        cost = r[3] if len(r) > 3 else ""
        sec.append(li(f"checklist_4_{idx}", spell_item(name, loc, cost, name in dlc_names)))
    out_sections.append(("Master_Of_Pyromancy", "Master of Pyromancy", "pyromancies", 4, sec))
    stats.append(f"pyro checklist_4: {len(sec)} items")

    # --- sheet2 gestures -> checklist 5
    rows = sheets[2][1:]
    sec = []
    for idx, r in enumerate(rows, start=1):
        name = r[0]
        giver = r[2] if len(r) > 2 else ""
        directions = r[3] if len(r) > 3 else ""
        text = f'<a href="{wiki(name)}">{esc(name)}</a>' if name else esc(name)
        if giver.lower() == "default" or not giver:
            text += " - Available at start" if not giver or giver.lower() == "default" else f" - {esc(giver)}"
        else:
            text += f" - {esc(giver)}"
        if directions:
            text += f" ({esc(directions)})"
        sec.append(li(f"checklist_5_{idx}", text))
    out_sections.append(("Gesture_Maestro", "Gesture Maestro", "gestures", 5, sec))
    stats.append(f"gestures checklist_5: {len(sec)} items")

    # --- sheet1 achievements -> checklist 6
    rows = sheets[1][1:]
    sec = []
    for idx, r in enumerate(rows, start=1):
        name = r[0]
        method = r[2] if len(r) > 2 else ""
        text = f"<strong>{esc(name)}</strong>"
        if method:
            text += f" - {esc(method)}"
        sec.append(li(f"checklist_6_{idx}", text))
    out_sections.append(("Achievements", "Achievements", None, 6, sec))
    stats.append(f"achievements checklist_6: {len(sec)} items")

    # --- sheet8 exiles -> checklist 7
    rows = sheets[8][1:]
    sec = []
    for idx, r in enumerate(rows, start=1):
        npc = r[0]
        loc = r[2] if len(r) > 2 else ""
        text = f"<strong>{esc(npc)}</strong>"
        if loc:
            text += f" - {esc(loc)}"
        sec.append(li(f"checklist_7_{idx}", text))
    out_sections.append(("Gathering_Of_Exiles", "Gathering of Exiles", None, 7, sec))
    stats.append(f"exiles checklist_7: {len(sec)} items")

    # --- sheet9 curious map -> checklist 8 (drop raw 1.0/2.0 step numbers, keep order)
    rows = sheets[9][1:]
    sec = []
    for idx, r in enumerate(rows, start=1):
        desc = r[2] if len(r) > 2 else ""
        text = esc(desc) if desc else ""
        sec.append(li(f"checklist_8_{idx}", text))
    out_sections.append(("Curious_Map", "Curious Map", None, 8, sec))
    stats.append(f"curious map checklist_8: {len(sec)} items")

    # --- sheet10 lucatiel -> checklist 9
    rows = sheets[10][1:]
    sec = []
    for idx, r in enumerate(rows, start=1):
        loc = r[0] if len(r) > 0 else ""
        speak = r[2] if len(r) > 2 else ""
        sign = r[3] if len(r) > 3 else ""
        boss = r[4] if len(r) > 4 else ""
        text = f"<strong>{esc(loc)}</strong>"
        bits = []
        if speak:
            bits.append(f"Speak: {esc(speak)}")
        if sign:
            bits.append(f"Sign: {esc(sign)}")
        if boss:
            bits.append(f"Boss: {esc(boss)}")
        if bits:
            text += " - " + ", ".join(bits)
        sec.append(li(f"checklist_9_{idx}", text))
    out_sections.append(("Lucatiel", "Lucatiel", None, 9, sec))
    stats.append(f"lucatiel checklist_9: {len(sec)} items")

    # Order sections for page: legacy 1,2,4,3,5, then Exiles, Lucatiel, Curious Map, Achievements last
    order = [1, 2, 4, 3, 5, 7, 9, 8, 6]
    by_num = {num: s for (_, _, _, num, _) in out_sections for s in [s for s in out_sections if s[3] == num]}
    # simpler: map num->entry
    by_num = {}
    for anchor, title, wiki_slug, num, lis in out_sections:
        by_num[num] = (anchor, title, wiki_slug, num, lis)

    toc_lines = []
    body_lines = []
    for num in order:
        anchor, title, wiki_slug, _, lis = by_num[num]
        toc_lines.append(
            f'                    <li><a href="#{anchor}">{esc(title)}</a> <span id="checklist_nav_totals_{num}"></span></li>'
        )
        if wiki_slug:
            h3 = (
                f'                <h3 id="{anchor}"><a href="#{anchor}_col" data-toggle="collapse" '
                f'data-parent="#tabPlaythrough" class="btn btn-primary btn-collapse btn-sm"></a>'
                f'{esc(title)} (Learn all <a href="http://darksouls2.wikidot.com/{wiki_slug}">{wiki_slug}</a>) '
                f'<span id="checklist_totals_{num}"></span></h3>'
            )
        else:
            h3 = (
                f'                <h3 id="{anchor}"><a href="#{anchor}_col" data-toggle="collapse" '
                f'data-parent="#tabPlaythrough" class="btn btn-primary btn-collapse btn-sm"></a>'
                f'{esc(title)} <span id="checklist_totals_{num}"></span></h3>'
            )
        body_lines.append(h3)
        body_lines.append(f'                <ul id="{anchor}_col" class="panel-collapse collapse in">')
        body_lines.extend(lis)
        body_lines.append("                </ul>")
        body_lines.append("")

    fragment = []
    fragment.append("                <!-- GENERATED FROM XLSX - DO NOT HAND EDIT, see tools/build_checklists.py -->")
    fragment.append("                <h2>Checklists <span id=\"checklist_overall_total\"></span></h2>")
    fragment.append("                <ul>")
    fragment.extend(toc_lines)
    fragment.append("                </ul>")
    fragment.append("")
    fragment.append("                <hr />")
    fragment.append("")
    fragment.extend(body_lines)

    out_path = HERE / "checklists_generated.html"
    out_path.write_text("\n".join(fragment) + "\n", encoding="utf-8")
    print(f"xlsx: {xlsx}")
    for s in stats:
        print(s)
    print(f"wrote {out_path} ({sum(len(by_num[n][4]) for n in order)} total items)")
    # contiguity check for calculateTotals()
    for num in order:
        lis = by_num[num][4]
        ids = [f"checklist_{num}_{i}" for i in range(1, len(lis) + 1)]
        for line, expected in zip(lis, ids):
            assert expected in line, f"non-contiguous id: expected {expected} in {line[:80]}"
    print("contiguity OK (calculateTotals loops 1..N without gaps)")


if __name__ == "__main__":
    build()
