#!/usr/bin/env python3
"""Segment-level agreement between Kev's verdicts and the 27B's keep ranges."""
import json, os, sys
segs = json.load(open(os.path.expanduser("~/bench-daily/take-transcript.json")))["segments"]
kev = {v["i"]: v for v in json.load(open(os.path.expanduser("~/bench-daily/kev-verdicts.json")))["verdicts"]}
keep27 = json.load(open(os.path.expanduser("~/bench-daily/keep-27b.json")))["keep"]
def kept_by_27b(s):
    mid = (s["start"] + s["end"]) / 2
    return any(a - 0.01 <= mid <= b + 0.01 for a, b in keep27)
rows = []; agree = 0
for i, s in enumerate(segs):
    k27 = kept_by_27b(s); kkev = not kev[i]["cut"]
    agree += (k27 == kkev)
    rows.append((i, s["start"], s["end"], "keep" if k27 else "cut", "keep" if kkev else "cut", kev[i]["why"], kev[i].get("confidence", 0), s["text"][:70]))
print(f"segments {len(segs)}  agree {agree}  disagree {len(segs)-agree}  ({100*agree/len(segs):.0f}% agreement)")
print("27B cut:", sum(r[3]=="cut" for r in rows), " Kev cut:", sum(r[4]=="cut" for r in rows))
print("\n| # | start | 27B | Kev | Kev why | conf | text |\n|---|---|---|---|---|---|---|")
for r in rows:
    if r[3] != r[4]: print(f"| {r[0]} | {r[1]:.1f} | {r[3]} | {r[4]} | {r[5]} | {r[6]} | {r[7]} |")
