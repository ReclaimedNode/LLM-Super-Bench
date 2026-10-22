import subprocess, json, select, sys
bin_ = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP"
script = open(sys.argv[1]).read(); unsafe = len(sys.argv) > 2 and sys.argv[2] == "unsafe"
p = subprocess.Popen([bin_], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
def send(o): p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
def recv_id(want, t=240):
    import time; end = time.time()+t
    while time.time() < end:
        r,_,_ = select.select([p.stdout],[],[],max(0.1, end-time.time()))
        if not r: break
        line = p.stdout.readline()
        if not line: break
        try: m = json.loads(line)
        except Exception: continue
        if m.get("id") == want: return m
    return None
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}); recv_id(1)
send({"jsonrpc":"2.0","method":"notifications/initialized"})
send({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_script_unsafe" if unsafe else "run_script","arguments":{"script":script,"timeout":200}}})
m = recv_id(2)
if m is None: print("NO RESPONSE")
else:
    try:
        for c in m["result"]["content"]: print(c.get("text",""))
    except Exception as e: print("RAW:", json.dumps(m)[:800], e)
p.kill()
