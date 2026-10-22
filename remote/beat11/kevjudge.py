#!/usr/bin/env python3
"""kevjudge: batched Kev judging (5 segments per call) plus a deterministic restart detector.
  python kevjudge.py judge [--batch 5] [--threshold 0.2] [--no-restart]
  python kevjudge.py ranges
"""
import json, os, re, sys, time, urllib.request
KEV = "http://127.0.0.1:8009/v1/systemone"
TRANSCRIPT = os.path.expanduser("~/bench-daily/take-transcript.json")
OUT = os.path.expanduser("~/bench-daily/kev-verdicts.json")
INSTR = ("Should {k} be cut from the final video? Cut it if the speaker stops and restarts the same sentence later, "
         "if it is a retake cue ('start from the top', 'do that again', 'one more time', 'damn it', 'hold on', 'I'm gonna wait'), "
         "or if it is talk about the recording itself instead of the topic. Keep it if a viewer should hear it.")

def ask(state, questions, kev=KEV, timeout=120):
    body = json.dumps({"model": "kev-latest", "state": state, "questions": questions}).encode()
    req = urllib.request.Request(kev, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def norm(t):
    return re.sub(r"[^a-z0-9 ]", "", t.lower()).split()

def restart_cuts(segs, lookahead=4, window_s=45.0):
    """Cut a segment when a later nearby segment restarts it (same opening words, longer version)."""
    cut = {}
    for i, s in enumerate(segs):
        a = norm(s["text"])
        if not a: continue
        for j in range(i + 1, min(len(segs), i + 1 + lookahead)):
            if segs[j]["start"] - s["end"] > window_s: break
            b = norm(segs[j]["text"])
            if len(b) < len(a): continue
            head = min(len(a), 4)
            same_head = a[:head] == b[:head] and head >= 2
            overlap = len(set(a) & set(b)) / max(1, len(set(a)))
            if same_head or (overlap >= 0.7 and len(a) >= 3):
                cut[i] = f"restarted in segment {j}"; break
    return cut

def judge(kev=KEV, transcript=TRANSCRIPT, out=OUT, batch=5, threshold=0.35, use_restart=True):
    segs = json.load(open(transcript))["segments"]
    t0 = time.time(); p_cut = [0.0] * len(segs); calls = 0; lat = []
    PROGRESS = out.replace(".json", "-progress.json")
    json.dump({"done": False, "judged": 0, "segments": len(segs), "seconds": 0.0, "started": t0}, open(PROGRESS, "w"))
    for b0 in range(0, len(segs), batch):
        idx = list(range(b0, min(len(segs), b0 + batch)))
        prev = segs[b0 - 1]["text"] if b0 > 0 else "(start of recording)"
        nxt = segs[idx[-1] + 1]["text"] if idx[-1] + 1 < len(segs) else "(end of recording)"
        lines = [f"PREVIOUS: {prev}"] + [f"S{n+1}: {segs[i]['text']}" for n, i in enumerate(idx)] + [f"NEXT: {nxt}"]
        qs = {f"cut_{n+1}": {"type": "noul", "instructions": INSTR.format(k=f"S{n+1}")} for n in range(len(idx))}
        r = ask("\n".join(lines), qs, kev=kev); calls += 1; lat.append(r.get("latency_ms") or 0)
        a = r.get("answers", {})
        for n, i in enumerate(idx): p_cut[i] = float(a.get(f"cut_{n+1}", {}).get("noul", 0.0))
        json.dump({"done": False, "judged": idx[-1] + 1, "segments": len(segs), "seconds": round(time.time() - t0, 1), "started": t0}, open(PROGRESS, "w"))
    wall = time.time() - t0
    rc = restart_cuts(segs) if use_restart else {}
    verdicts = []
    for i, s in enumerate(segs):
        kev_cut = p_cut[i] >= threshold
        why = ("restart" if i in rc else ("kev" if kev_cut else "keep"))
        verdicts.append({"i": i, "start": s["start"], "end": s["end"], "text": s["text"], "p": {"cut": p_cut[i]},
                         "cut": bool(kev_cut or i in rc), "why": why, "confidence": round(p_cut[i], 2), "note": rc.get(i, "")})
    summary = {"segments": len(segs), "cut": sum(v["cut"] for v in verdicts), "kev_cut": sum(v["why"] == "kev" for v in verdicts),
               "restart_cut": len(rc), "kept": sum(not v["cut"] for v in verdicts), "kev_calls": calls, "decisions": len(segs),
               "wall_seconds": round(wall, 1), "median_call_ms": sorted(lat)[len(lat)//2] if lat else None, "threshold": threshold, "batch": batch}
    json.dump({"summary": summary, "verdicts": verdicts}, open(out, "w"), indent=1)
    json.dump({"done": True, "judged": len(segs), "segments": len(segs), "seconds": round(wall, 1), "started": t0, "summary": summary}, open(PROGRESS, "w"))
    return summary

PROGRESS_FILE = OUT.replace(".json", "-progress.json")

def start(batch=5, threshold=0.35):
    """Start the Kev pass as a detached background process; returns at once."""
    import subprocess, os
    if os.path.exists(PROGRESS_FILE): os.remove(PROGRESS_FILE)
    if os.path.exists(OUT): os.remove(OUT)
    py = os.path.expanduser("~/bench-envs/llm/bin/python")
    subprocess.Popen([py, __file__, "judge", "--batch", str(batch), "--threshold", str(threshold)],
                     cwd=os.path.dirname(__file__), stdout=open(OUT.replace(".json", "-run.log"), "w"), stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True)
    return {"started": True, "batch": batch, "threshold": threshold}

def wait(max_seconds=50, poll=2.0):
    """Block up to max_seconds; print progress; return the progress dict (done True when finished)."""
    import os
    end = time.time() + max_seconds; last = None
    while time.time() < end:
        try: pr = json.load(open(PROGRESS_FILE))
        except Exception: pr = None
        if pr and pr != last:
            print(f"Kev judged {pr['judged']}/{pr['segments']} segments in {pr['seconds']} s" + ("  DONE" if pr.get("done") else "")); last = pr
        if pr and pr.get("done"): return pr
        time.sleep(poll)
    return last or {"done": False, "judged": 0}

def rethreshold(threshold=0.35, path=OUT, transcript=TRANSCRIPT, use_restart=True):
    """Re-decide from stored probabilities without asking Kev again."""
    d = json.load(open(path)); segs = json.load(open(transcript))["segments"]
    rc = restart_cuts(segs) if use_restart else {}
    for v in d["verdicts"]:
        i = v["i"]; kev_cut = v["p"]["cut"] >= threshold
        v["cut"] = bool(kev_cut or i in rc); v["why"] = "restart" if i in rc else ("kev" if kev_cut else "keep"); v["note"] = rc.get(i, "")
    d["summary"].update({"threshold": threshold, "cut": sum(v["cut"] for v in d["verdicts"]), "kev_cut": sum(v["why"] == "kev" for v in d["verdicts"]),
                         "restart_cut": len(rc), "kept": sum(not v["cut"] for v in d["verdicts"])})
    json.dump(d, open(path, "w"), indent=1); return d["summary"]

def keep_ranges(path=OUT, max_gap=2.0):
    d = json.load(open(path)); rng = []
    for v in d["verdicts"]:
        if v["cut"]: continue
        if rng and v["start"] - rng[-1][1] <= max_gap: rng[-1][1] = v["end"]
        else: rng.append([v["start"], v["end"]])
    return [tuple(r) for r in rng]

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "judge"
    arg = lambda k, d: type(d)(sys.argv[sys.argv.index(k)+1]) if k in sys.argv else d
    if cmd == "judge":
        s = judge(batch=arg("--batch", 5), threshold=arg("--threshold", 0.35), use_restart="--no-restart" not in sys.argv)
        print(json.dumps(s))
        for v in json.load(open(OUT))["verdicts"]:
            if v["cut"]: print(f"CUT {v['start']:7.2f}-{v['end']:7.2f} p={v['p']['cut']:.2f} {v['why']:8s} {v['text'][:60]} {v['note']}")
        kr = keep_ranges(); print("keep ranges:", len(kr), "cut length seconds:", round(sum(e - s for s, e in kr)))
    elif cmd == "start":
        print(json.dumps(start(batch=arg("--batch", 5), threshold=arg("--threshold", 0.35))))
    elif cmd == "wait":
        print(json.dumps(wait(arg("--max", 50))))
    elif cmd == "rethreshold":
        print(json.dumps(rethreshold(float(sys.argv[2]) if len(sys.argv) > 2 else 0.35)))
    elif cmd == "ranges":
        print(json.dumps(keep_ranges()))
