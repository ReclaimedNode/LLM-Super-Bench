# The inherited benchmark suite

> **Not maintained here.** Everything below comes from NetworkChuck's original project,
> [theNetworkChuck/mac-studio-m5-ultra-local-ai](https://github.com/theNetworkChuck/mac-studio-m5-ultra-local-ai) (MIT),
> and describes the code in this repository as it was copied, under the new name. It is not part of the
> race, sweep, charts or machine setup, none of which depend on it. For the latest version, the video and the
> data, see the original repository.

## Everyday jobs: `bun run daily`

One ordinary job — the work that actually fills a day here — sent to every Mac in
`bench.config.json` at the same instant, each machine timing itself.

```bash
bun run daily                                       # the five jobs, and what each one does
bun run daily hevc                                  # transcode the take on the hardware encoder
bun run daily footage --model 8b                    # a minute of footage, smaller vision model
bun run daily transcribe --model turbo --file day   # the whole shoot day, through turbo
```

The transcription is the one with two things to choose. `--model` picks the Whisper weights —
`large-v3`, `turbo`, `medium`, `small`, `base` or `tiny`, largest first, with `large-v3` the
default because that is what a real take gets — and `--file` picks the recording: `take` for the
13.8-minute take, `day` for the whole shoot day at 2 h 5 min. Both are named in the job's
description and in the label the seconds sit under, so a number never appears beside a model or a
recording it did not come from. On the footage job `--model` means the vision model instead
(`32b` or `8b`); on the other three jobs either flag is an error rather than something quietly
ignored. Nothing is copied first: every machine already has these files under `~/bench-daily`.

## One clip on every Mac: `bun run clip`

One prompt, one short video on each Mac, all of them starting at the same moment.

```bash
bun run clip "a paper plane over a city at night"              # 512x256, two seconds
bun run clip "a city at night" --size big                      # 704x480, four seconds
bun run clip "make it fly" --image ~/Desktop/fox.png           # the picture becomes frame 0
```

`--image` takes a `.png` or a `.jpg` on this Mac. It is read once here, copied to every machine
into that run's folder beside the clip it becomes, and handed to the port as the clip's first
frame. The picture can be any shape: the port resizes and centre crops it to the clip's own
geometry, so a square 1024 drawing needs nothing done to it. Without `--image` the command sent to
each machine is exactly what it was before, character for character. The seconds include the model
load, for the reason the video section below gives.

## One screen for every test: `bun run show`

For the camera. `bun run show` serves one page (port 9800, or `showPort` in `bench.config.json`)
with both Macs side by side, a button per test (draw, clip, hevc, prores, transcribe, footage,
laya), a prompt box where a test takes one, START, a live clock in each lane while it runs, then
the number with its label, the picture or the clip inside the lane, the captured answer for the
footage and Laya tests, the CLI's own verdict sentence under both lanes, and a results log. All
timing happens on the server, like the race page; the browser only displays. It runs the same
remote commands as the CLIs (it imports their command builders) and keeps media under
`results/show/<stamp>/`, which is the only folder it serves. One test at a time; a second START
while one is running is refused with a sentence.

**The live strip.** Under each lane's name, six numbers off that machine's own chip, updating
twice a second whether or not a test is running: GPU percent, GPU watts, CPU percent, RAM used
against total, the Neural Engine's watts, and the GPU's temperature. They come from `macmon pipe`
running over ssh at `~/.local/bin/macmon`, which is not on the PATH a non-interactive ssh gets and
so is named in full. One reader per machine is started when the first page connects and killed
when the last one goes away, so reloading the page all day cannot leave ssh processes behind. The
Neural Engine is spelled out because it sits at 0 W through every test here, and that is the
point. A lane whose machine is not reporting — asleep, no macmon, ssh refused — shows dashes,
the server logs one line, and the tests and the other lane are untouched: the strip is a separate
stream that never takes the run lock.

**CLIP has a second row of buttons**: FROM SCRATCH, which is what it has always done, and FROM
LAST PICTURE, which starts each lane's clip on the most recent picture THAT lane drew in this
server's lifetime — draw on both Macs, then watch both Macs animate what they drew. If a lane has
not drawn anything yet, START is refused with a sentence naming it before any machine is touched.
The line under the buttons and the label under the seconds both say when a run started from a
picture.

## Filming notes

- The page makes **zero external network requests**: no CDN, no web fonts, no analytics, no
  telemetry. Fonts are a local/system stack, the favicon is an inline `data:` URI, and the only
  outbound calls the tool ever makes are to the lane URLs in your config.
- Base URLs, hostnames and IPs never reach the browser.
- **Thinking models eat the budget.** With a reasoning model, a low `maxTokens` can
  be consumed entirely by the thinking block, leaving the reply pane empty. Raise `maxTokens`, or
  turn thinking off in your prompt, before you film.

## The benchmark

The race is the show. The benchmark is the measuring engine behind it: it runs a whole grid of
tests across the same machines on its own, for an hour or two, and produces numbers that can be
published and checked afterwards from a saved log.

```bash
bun run mock         # terminal 1, same as the race
bun run bench --plan # every cell that would run, and a rough clock. Runs nothing.
bun run bench        # run it; the progress page prints its URL
bun run board        # the results board for the newest run
bun run power        # the wall-meter pass, when you have a meter in your hand
bun run setup-lane X # prepare a machine to be lane X
bun run imagebench   # the image-generation grid
bun run videobench   # the video grid (experimental)
```

A **cell** is one lane × one model × one prompt length. Each cell is one warm-up run that is
thrown away, then N measured runs (default 5), with a rest between cells (default 30s) so a hot
machine is never measured against a cold one. Lanes run at the same time, because they are
separate machines; cells inside one lane run strictly one at a time, because two cells on one
machine would be measuring each other.

Per cell it reports the **median**, lowest and highest of:

| | what it is |
|---|---|
| Reading speed | true prompt tokens ÷ seconds waiting for the first word |
| Writing speed | `(output tokens − 1) ÷ (last piece − first piece)`, the race's own formula |
| First word | seconds |

Never a mean. A mean of five runs hides the one that was three times slower; the range does not.

### The honesty rules

These are not options.

- **True counts only.** Every speed divides by the token counts in the server's `usage` frame.
  The nominal size (512, 4K, 32K) is the cell's *label*, never a measurement. To make the label
  honest, one small probe per model measures its characters-per-token, and the discarded warm-up
  corrects the scale for free — no binary search, because at 100K tokens a wrong guess costs
  minutes per request.
- **No cache can help.** Every prompt opens with a unique run-id line, the server is started
  with `--prompt-cache-size 0`, and every run's `cached_tokens` is logged anyway. Above zero and
  the run is excluded, with the reason on the board.
- **Run to the cap.** The prompt asks for a long answer and `max_tokens` stops it. A run whose
  true output is under 90% of the cap is excluded from the medians and flagged where it would
  have appeared.
- **Thinking is named.** The server is started with `--chat-template-args
  '{"enable_thinking":false}'`. Either way the run records which streamed field carried the
  first word, and the board says so when it was not `content`.
- **Nothing silently vanishes.** A failed, excluded or flagged cell is marked on the board and
  in report.md. A cell with no usable number is a gap with the reason written in it, never a
  zero-height bar.
- **One failure is not the end.** A cell that errors is logged, marked, and stepped over.

### Resuming

Every finished run is appended to `runs.jsonl` before the next one starts. Kill the process at
any moment and you lose at most the run in flight; run the same grid again and it skips the
cells that already have their runs, unless you pass `--force`.

### Preparing a machine: `bun run setup-lane <lane>`

A second machine has to end up comparable with the first, and the numbers only
mean anything if both run the same versions of the same tools against the same
weights at the same paths.

```bash
bun run setup-lane "Studio" --plan    # what it would do, and do nothing
bun run setup-lane "Studio"           # do it
bun run setup-lane "Studio"           # again: changes nothing
```

For a managed lane, over ssh and as the user — never `sudo`, never Homebrew,
never the system Python:

1. **`uv`**, installed with its own official installer if it is missing.
2. **An environment per kind of model** under `~/bench-envs`, on a pinned
   Python, holding **pinned** versions. `mlx==0.32.2` and `mlx-lm==0.31.3` for
   language models — the versions the first machine already runs, read out of
   its own `system_fingerprint`. "Latest on both machines" is not a control,
   it is a coincidence.
3. **Every model at `~/bench-models/<dir>`**, the same path on every machine:
   symlinked when that machine already has a copy somewhere, downloaded from
   Hugging Face by repo id when it does not. Downloads resume; they never
   restart.
4. **A verification pass** that reads the machine back — versions as installed,
   each model's safetensors count and size, free disk — rather than summarising
   what the steps believe they did.

Free disk is checked **before** a download starts, against the model's size
plus headroom. Every step checks before it acts, so running it again is free.

In the config a model gains `dir` (its folder name, and therefore its id on
every lane), `hfRepo`, `kind`, and `approxGb`; a lane gains `localPaths`,
keyed by `dir`, naming copies that machine already has:

```jsonc
"models": [
  { "name": "Some Model", "dir": "Some-Model-4bit", "hfRepo": "vendor/Some-Model-4bit",
    "kind": "llm", "approxGb": 8,
    // Optional, and printed on the board exactly as written — write a whole
    // phrase: "27B dense" or "35B total, 3B active per token".
    "quantization": "4-bit", "fileSize": "15 GB", "activeParams": "27B dense" }
],
"lanes": [
  { "label": "Studio", "baseUrl": "http://<host>:8090",
    "ssh": { "host": "<host>", "binDir": "~/bench-envs/llm/bin", "port": 8090 },
    "localPaths": { "Some-Model-4bit": "~/somewhere/it/already/is" } }
]
```

With a `dir` the model's `id` defaults to `~/bench-models/<dir>`, so one config
works on every machine and there are not two fields to keep in step.

### Images: `bun run imagebench`

The same method, applied to pictures. One warm-up image then N measured ones
per lane per model, from an identical prompt, seed, size (1024×1024) and step
count everywhere, resting between cells, every image written to disk as it
lands, resumable, fail-soft, medians with the range beside them.

The tool on the Macs is [mflux](https://github.com/filipstrand/mflux), pinned
to `0.19.2`, driving `mflux-generate-flux2` and `mflux-generate-z-image-turbo`.
Step counts are left unset so mflux uses its own default for each model — 4 for
`flux2-klein-4b`, 9 for `z-image-turbo` — rather than a number invented here.

**The honest number is the seconds to make one image with the model already in
memory.** Loading the weights is timed too, reported separately, and never
folded in; otherwise a machine with faster storage looks like a machine with a
faster GPU. mflux's command line loads and generates in one process and prints
no per-image timing, so `remote/mflux_bench.py` — a small shim copied to the
machine over the same ssh — loads once, times each generation, and prints one
JSON line per image. It builds its arguments with **mflux's own parser**, so
every default it does not name comes from mflux at the pinned version.

Because the seed is fixed, every lane should draw the *same picture*. The
images come back into the run folder and the board shows them side by side as
proof, with a checksum per lane; if two lanes disagree, the board says so
instead of presenting two different pictures as one test.

`bun run setup-lane` installs this environment and these models alongside the
language ones — give the model `"kind": "image"` in the config.

### Managed and manual lanes

A lane with an `ssh` block is **managed**: the runner starts `mlx_lm.server` on that machine for
each model, waits until `/v1/models` lists it, runs that model's cells, and stops *the process it
started, by pid* — never `pkill`. Without an `ssh` block the lane is **manual** and the progress
page says which model a human needs to load, on which machine.

Managed lanes also run the engine's own `mlx_lm.benchmark` after each model's API cells: the same
work with no HTTP server, no chat template and no network, plus peak memory, which nothing on the
API side can see. That tool prints only a mean, so its per-trial lines are kept and the median,
lowest and highest computed here, to be the same statistic as the API numbers beside it.

#### Sleep

A freshly set up Mac can have system sleep set to **one minute**, and neither an open ssh session
nor a running download counts as activity: the machine drops off the network partway through and
every symptom points at the network instead. `pmset -g` shows `sleep 1` on such a machine where a
long-lived one shows `sleep 0`.

So every managed operation that can outlast a minute — `bun run bench`, `setup-lane`, `imagebench`,
`videobench`, `power` — starts `caffeinate -dimsu -t <seconds>` on that lane over ssh, records its
pid, and stops *exactly that pid* at the end, including after a failure and after Ctrl-C. No sudo,
no change to the machine's own settings, and nothing left behind: `-t` makes the hold expire on its
own even if the runner is killed outright. `bun run bench --plan` prints a line for any lane whose
sleep setting is not 0, and each operation prints the same line before it starts work.

The power pass holds the display on too, for the whole pass: a display that slept between the idle
reading and the load reading would make the two readings incomparable at the wall.

Every config value that reaches a remote command line is checked against an allow-pattern of
letters, digits and `_ . / ~ -` and then quoted; anything else refuses to run, naming the field.
Copy `bench.config.example.json` to `bench.config.json` — it is gitignored, and it is where
hostnames and model paths live.

### What lands on disk

`results/bench/<run-name>/`, all gitignored:

```
runs.jsonl    one line per run: every measured number, true and nominal sizes,
              cached tokens, the server's version string, the timestamp
cells.json    the medians and ranges per cell
report.md     plain Markdown tables to paste in public, with the settings
              and software versions at the bottom
manifest.json what the run was configured to do
engine.json   the engine benchmark's numbers, when there are any
power.json    the wall-meter readings, when there are any
```

### Two machines, one board: `bun run merge-runs`

One run folder cannot safely take two writers, so two machines are benchmarked as two invocations
with two run names, and the board that gets filmed is built from both afterwards:

```
bun run bench --run final          # on the first machine's invocation
bun run bench --run final-new      # on the second machine's invocation
bun run merge-runs final final-new --into both
bun run board both
```

The merged folder is a third folder. Neither source is opened for writing — they are the only copy
of a measurement that took hours. It reads like a run that had both lanes in it from the start: the
board shows the two machines side by side under each model heading with the headline ratio, and
`report.md` has the same tables in Markdown, with a **Merged from** line in the settings block
naming both runs and which lanes each contributed.

It **refuses** when the two runs were not measuring the same thing — a different output cap, a
different number of measured or warm-up runs, different prompt lengths, a different prompt file, a
different temperature, thinking off in one and on in the other, or two lanes sharing a name — and
names both values, so the fix is obvious. Every refusal is reported at once rather than one per
attempt, and nothing is written when it refuses.

Differences that are simply facts about two machines — lane names, software versions, start times,
a model only one of them ran — are printed and merged. A model only one machine ran gets a heading
with one lane in it.

### Power

`bun run power` is for a person holding a plug-in wall meter. Nothing reads a sensor: it puts one
machine under steady generation load, holds it (default 60s), keeps the load running while it
asks, and takes the number typed in. One idle reading per lane as well. Lanes go one at a time —
one meter, one machine. The board then shows watts and tokens per watt, labelled "wall meter,
read by hand" wherever they appear.

## Video (experimental)

`bun run videobench` times LTX-2.5 through an MLX community port, pinned to one
commit so a number can be reproduced when the branch moves:

```
xocialize/ltx-2-mlx, branch ltx-2.5, commit c952c8f601e4fc5371d91b609ef5e0d85ba23751
weights: mlx-community/ltx-2.5-mlx-q8
```

One warm-up clip then three measured ones per lane, at a fixed prompt, seed and
geometry. The default clip is deliberately small — 512×288, 49 frames, which is
two seconds at 24fps — because nothing here has been timed and the default
should finish in a few minutes rather than look impressive. Frame counts must
be **8k+1**; the tool refuses anything else and names the nearest valid count.

**Seconds per clip include the model load.** The port loads and generates in
one invocation and prints a single `Time:` line for the lot, so unlike the
image side there is no honest way to split them without a second shim. Every
lane pays the same load, so lanes stay comparable — the number is simply not a
pure generation time, and no label here claims it is.

Fail-soft throughout: if the port will not clone, will not sync, or will not
generate, that lane has no video, the rest of the tool is untouched, and the
board says why.

**Disclosure.** The LTX-2 Community License's acceptable-use policy forbids
generating or disseminating content "without expressly and intelligibly
disclaiming that the information and/or content is machine generated", and §6
puts the transparency obligations on whoever deploys it. Clips produced here
are machine generated and must be said to be, wherever they are shown. The
board prints that line under every video section, and the tests page
prints it under every clip.


