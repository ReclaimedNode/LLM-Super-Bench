A stand-in for mflux, only as much of it as remote/mflux_bench.py touches.

It exists so the shim's own control flow -- argument building through mflux's
parser, model construction, the load/generate split, the timing, the checksums
and the JSON it prints -- can be run and asserted without a Mac, mflux, or
twelve gigabytes of weights.

It proves the shim. It does NOT prove that mflux's real API matches this shape:
that is what the first live cell is for.
