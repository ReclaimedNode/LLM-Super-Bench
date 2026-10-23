# LLM-Super-Bench

> **Based on the harness in NetworkChuck's [mac-studio-m5-ultra-local-ai](https://github.com/theNetworkChuck/mac-studio-m5-ultra-local-ai)** (MIT).
> This is an independent project built on that work, not an official release. The original race, scoreboard and
> timing rules are NetworkChuck's; see [Credits](#credits) and [NOTICE.md](NOTICE.md) for what was added.

(Formerly "LLM Race". The commands and file names, such as `bun run race` and `race.config.json`, are unchanged.)

Send the same prompt to two, three or four computers running local AI models at the same
instant. Watch the replies stream side by side. Get an honest scoreboard.

It is both the measuring instrument and the on-camera graphic, so the rule throughout is that
no number appears under a name it has not earned.

## Run it yourself, from zero

**What you need**
- One computer to run this page (any Mac, Linux or Windows machine with [Bun](https://bun.sh) installed). It only sends requests and draws charts, so a small machine is fine.
- One or more computers running a local model behind an **OpenAI-compatible server**. That is the thing being tested. Common ways to get one (check each engine's own docs for the current command):
  - llama.cpp: `llama-server -m model.gguf --host 0.0.0.0 --port 8000`
  - vLLM: `vllm serve <model> --host 0.0.0.0 --port 8000`
  - Ollama, LM Studio, SGLang, TGI, KoboldCpp, TensorFold, MLX-LM: start their server and note its address. See [Engines](#engines).
- The machines must be reachable from the computer running this page. Bind the server to `0.0.0.0` (not just localhost) and allow the port through any firewall.

**Steps**
1. `git clone https://github.com/reclaimednode/LLM-Super-Bench && cd LLM-Super-Bench`
2. Try it with no hardware first: `bun run mock` in one terminal, `bun run race` in another, open the URL it prints and press START.
3. Point it at your real machines: `RACE_PASSWORD='something-long' bun run race`, open the page, and add each machine's name and address under **MANAGE MACHINES** (for example `http://192.168.1.50:8000`). The page asks each machine what it is running and saves the list for you.
4. Pick **HEAD TO HEAD** or **SOLO**, a prompt size and a stream count, then press START. Use **SWEEP** to run many sizes and stream counts in one go.
5. When it finishes, **VIEW CHARTS** shows the graphs and **DOWNLOAD DATA** saves a file you can send to others to compare. See [Charts and sharing results](#charts-and-sharing-results).

Run a model that thinks before it answers? Read [Thinking models](#thinking-models) first, or the reply may look empty.

## Quick start (a headless Mac Mini and your machines)

You need [Bun](https://bun.sh) and nothing else. No `bun install`: there are no dependencies.

```bash
# Start the page. The password is what lets you manage the machines from the page.
RACE_PASSWORD='something-long' bun run race
```

Then, **from any other computer on the network**, open `http://<the Mini's name or IP>:9500`
(for example `http://your-mac-mini.local:9500`). The server listens on every network address, so the
Mini needs no screen. The browser asks for the password once; any user name works.

On a first run the page opens **MANAGE MACHINES** for you. Enter each machine's name and address
(for example `http://192.168.1.50:8000`). As soon as an address is entered the page asks that
machine and shows what answered: model file, quantization, build, slots and context. Press
**SAVE AND USE** and the machines are in use at once, with no restart. The list is written to
`race.config.json`, and you can change it again at any time.

Then open **MACHINE DETAILS**, run a 4K race, and try a small **SWEEP**.

Prefer the command line? This does the same job:

```bash
bun run init "Mac Studio=http://192.168.1.50:8000" "CMP 170HX=http://192.168.1.51:8000" \
  --notes "Mac Studio=-c 262144, spec decoding on"
```

To keep it running across reboots on the Mini, see *Hosting and the password* below.

## Manage machines

**MANAGE MACHINES** follows the choice under **MACHINES** at the top. **HEAD TO HEAD** shows two
machine rows and **SOLO** shows one. For each: a name (what the scoreboard shows), an address, and
optional notes about how it was started. In solo you change the first machine only; the second one
you saved stays for head to head as long as it still answers. **SAVE AND USE** asks every machine for its exact model id first, and saves only if
all of them answer, so a typo cannot leave the page pointing at nothing. A machine you keep keeps the
settings the page does not show (API key, slot count, extra request fields). Saving is refused while
a race is running.

It needs the password (`RACE_PASSWORD`). Without one the panel says so and does nothing, because
letting the page change addresses would let anyone on the network make this server ask any address.

## Run it

```bash
bun install          # no dependencies; this is a no-op and works offline
bun run mock         # terminal 1: two fake lanes, no AI hardware needed
bun run race         # terminal 2: prints the URL
```

Open the URL, press START. That works out of the box with no config, because with no
`race.config.json` the tool falls back to `race.config.example.json`, which points at the mock
lanes.

Three rows of buttons sit above START and decide what the race is: which **machines** (head to
head, or any one of them on its own), how big a **prompt** (Short up to 128K), and how many
**streams per machine** (1 up to however many the machines you picked can run at once). See [Choosing what to race](#choosing-what-to-race).

```bash
bun run report              # median of the last 10 runs per lane and preset
bun run report --last 30
bun test
```

## Configure the real lanes

Copy the example and edit it. `race.config.json` is gitignored: it is where hostnames live, and
they never go in git.

```bash
cp race.config.example.json race.config.json
```

```jsonc
{
  "port": 9500,
  "maxTokens": 512,        // cap on each reply, so a race cannot run forever
  "temperature": 0,
  "charsPerToken": 4,      // how the 8K / 32K presets convert tokens to characters
  "promptFile": "prompts/sample.txt",
  "requestTimeoutMs": 180000,
  "preflightTimeoutMs": 30000,
  "maxConcurrency": 16,    // the most streams per machine the page offers (powers of two up to this)
  "lanes": [
    {
      "label": "Desktop",                        // what the screen calls it
      "baseUrl": "http://<host-a>:8090",         // no /v1 on the end
      "model": "/full/path/as/the/endpoint/lists/it",
      "displayModel": "Model-A-4bit",            // optional; defaults to the last path segment
      "slots": 4,                                // optional; see "How many streams" below
      "extraBody": { "chat_template_kwargs": { "enable_thinking": false } },  // optional; extra request fields for this machine
      "notes": "-c 262144, spec decoding on"      // optional; how it was started, which the API cannot report
    },
    { "label": "Laptop", "baseUrl": "http://<host-b>:8090", "model": "..." }
  ]
}
```

Two to four lanes. Any OpenAI-compatible streaming chat endpoint works
(`POST {baseUrl}/v1/chat/completions` with `stream: true`).

**The model id must be exactly what the endpoint lists at `GET {baseUrl}/v1/models`.** Some
servers, `mlx_lm.server` among them, treat an unrecognised `model` as a model to go and
*download*, so a typo becomes a call out to huggingface.co and a 404. The tool checks the model
list before every race and refuses to start a lane whose id is not there, naming what the
endpoint does have.

`displayModel` exists because a real model id is often a full filesystem path containing your
username. The screen shows the last path segment by default, and base URLs are never sent to
the browser at all.

## Start the servers: `bun run lanes`

The race page does not start anything — it points at two endpoints that are already serving. Starting
them by hand is a pair of long ssh one-liners that have to be right about six things at once, so it is
written down instead:

```bash
bun run lanes up       # start a model server on every lane in race.config.json
bun run lanes status   # what is running, and what each endpoint is serving
bun run lanes down     # stop exactly what `up` started, by pid
bun run race           # then the page

bun run lanes up --model 14b   # or start them all on a named model instead
```

The host and port come from each lane's `baseUrl`, the model from its `model`, and the binaries from
`~/bench-envs/llm/bin` unless the lane carries an `ssh` block saying otherwise. Every server binds
`0.0.0.0`, runs with the prompt cache off and thinking off, and writes to `/tmp/llm-race-server-<port>.log`
on its own machine.

### Changing the model without editing the config

`--model <key>` starts every lane on that model instead of the one in the config, for this session
only. `race.config.json` is never written to:

```bash
bun run lanes down
bun run lanes up --model 14b
# then reload the race page — `bun run race` keeps running
```

| key | on the screen | folder under `~/bench-models` |
|------|--------------------------|--------------------------|
| `14b` | Qwen3 14B 4-bit | `Qwen3-14B-4bit` |
| `27b` | Qwen3.8 27B 4-bit | `Qwen3.8-27B-4bit` |
| `31b` | Gemma 4 31B 16-bit | `gemma-4-31b-it-bf16` |
| `122b` | Qwen3.5 122B-A10B 4-bit | `Qwen3.5-122B-A10B-4bit` |
| `35b` | Qwen3.6 35B-A3B 4-bit | `Qwen3.6-35B-A3B-4bit` |

Each key is a folder every lane machine carries, so one key starts the same weights on both —
two machines running different models is not a race. A key the tool does not know, and `--model`
with nothing after it, are both refused by name, and nothing is started.

What `up` started goes into `.lanes.json` beside the pids: the model id, the name for the screen,
and the key. **The race page reads that record on every load, and the race sends that model id in
every request** — so `lanes down`, `lanes up --model 31b`, reload changes what the lane headers
say and what actually gets raced, with `bun run race` left running the whole time. Preflight
checks the endpoint for the started model rather than the config's. With no record — nothing
started by this tool, or `lanes down` since — every lane falls back to its `model` and
`displayModel` in `race.config.json`. `bun run lanes status` prints the model each lane is
serving.

Two things it is careful about:

- **A lane is not up because a process started.** It is up when the endpoint LISTS the exact model id
  the race will ask for — because the race's own preflight refuses anything else, and because
  `mlx_lm.server` treats an unknown model name as one to go and *download*. A lane that never lists it
  is stopped again rather than left half-started, and the message says what the endpoint is serving
  instead.
- **Everything it starts, it stops by pid.** The server's pid and its keep-awake's pid are written to
  `.lanes.json` (gitignored) the moment they are known, and `down` stops exactly those. Never a pattern
  match: these machines run other things, and `pkill -f mlx_lm.server` is a way to take down somebody
  else's work.

Each machine is also held awake while it serves, because a Mac set to sleep after a minute will drop
off the network mid-race and it looks like a network fault when it does.

**A sleeping machine is woken, not reported as broken.** The first ssh to a Mac that is asleep fails
with "Operation timed out"; a ping wakes it and a retry a few seconds later works. So every managed
command — `lanes up`, `setup-lane`, `bench`, `imagebench`, `videobench`, `power` — makes its first
contact through one shared step that, on a sleep-shaped failure, pings the host and tries again, up to
four tries over about half a minute, saying so in plain words each time. A failure that waiting cannot
fix — an unauthorised key, a hostname that does not resolve, a changed host key — is never retried:
it fails on the first try with the error ssh gave. If the last try still fails, the message says what
a person can do: press a key on that Mac, or turn automatic sleep off in System Settings.

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

## Choosing what to race

Three rows of buttons, all read when you press START and locked while a race runs. Nothing on
the screen is a number from a different race than the one it sits under: a choice the page
sends that the server does not recognise is refused with a sentence, never quietly turned into
something else.

**Machines.** `HEAD TO HEAD` races every lane in `race.config.json` at the same instant. Pressing
a lane's own name races that machine alone, and the other lane's tile is not drawn. One machine
has nothing to be ahead of, so the board is headed RESULT instead of SCOREBOARD and its sentences
say what the machine did ("Studio reached the first word in 1.2s") instead of naming a winner.
Only the machines picked are preflighted and sent a request. Each lane's id is its position in the
config, so a lane keeps its tile whichever machines are in the race.

**Prompt size.** The preset table below. Short has no source text; the rest read that many
approximate tokens of `promptFile`.

**Streams per machine.** How many requests each machine is sent at the same instant: 1, 2, 4, 8
and so on, up to what the machines can run at once (see below) and never past `maxConcurrency`. Every machine gets the same number, and stream *N* on one machine
reads the same prompt as stream *N* on the other. The prompts differ from each other only in their
`[race-run <id>-s<N>]` first line, so no stream can be served from another's cache. With more than
one stream the lane's numbers mean this, and the tile and the scoreboard say so under each:

| shown | what it is |
|---|---|
| FIRST WORD | the **median** of the streams' first words ("median of 4 streams") |
| SPEED PER STREAM | the median over the streams of each stream's own speed, by the race's formula |
| ALL STREAMS | every stream together, below |
| TOTAL | until the **last** stream finished |

```
all streams = sum of (count - 1) over the streams
              -----------------------------------------------
              (latest last piece) - (earliest first piece)
```

It is the speed formula with the gaps added up and the window widened to cover all of them, so
with one stream it *is* the speed formula. Like speed it leaves out the wait before the first
word, so a machine that prefilled slowly is marked down once, on first word. Two streams that ran
one after the other are not counted as if they overlapped: the window stretches across both.

The lane's text pane follows stream 1 and says so ("Showing stream 1 of 4"); the numbers count
all of them. If some of a lane's streams fail, the lane is still scored on the ones that finished
and a note on the board names how many did not. A lane that lost streams carried less load than
its rival, so it is left out of the ALL STREAMS ranking and the note says that too. If every
stream of a lane fails, the lane failed and the reason is shown.

**How many streams: the page asks the machines.** Whenever you pick machines (and when the page
loads) it asks each one how many requests it runs at once, and draws only the stream counts those
machines can run. For llama.cpp's `llama-server` that is `total_slots` from `GET /props`; the
context it reports for one request is shown beside it. In a head-to-head the smaller of the two
decides, since both get the same number. A server that cannot say (vLLM, mlx_lm.server, or one that
is down) is shown as "can't tell" and does not lower the limit; for those, put `"slots": N` on the
lane in `race.config.json` (vLLM's `--max-num-seqs`, say) and that number is used instead of asking.
The server asks again when the race starts, so a restart with a different `-np` is picked up. If a
race still asks for more streams than a machine runs at once, the scoreboard says how many waited
in its queue and that its first word and total are not like for like.

**Prompt sizes that may not fit.** The page also reads each machine's reported context. A size
whose prompt plus the reply cap (`maxTokens`) looks bigger than that is drawn with a dashed border,
and a line under the sizes names the machine. It is a warning and never a block: servers differ in
whether the context they report is per slot or shared, so you decide. A prompt that really does not
fit comes back as an error on that machine.

**The server decides how much of this it can do.** Streams beyond what a server will run at once
are queued by it, and a queue shows up as a later first word on the later streams, not as an
error. With llama.cpp's `llama-server`, start it with enough slots (`-np`, or `--parallel`) for
the number you will ask for, and remember that its context is divided between the slots, so a
long prompt at high concurrency needs a `-c` large enough for its share. A request that does not
fit comes back as an HTTP error on that lane and is shown as one.


## Stopping a race or a sweep

While a race or sweep is running a **STOP** button appears beside START. It cuts every request off
at once. The machines see their connections close and stop generating, so a 128K prompt does not
keep a machine busy after you have given up on it. Each lane is marked STOPPED (not FAILED), the
scoreboard says it was stopped and does not score it, and the stopped run stays in `results/runs.jsonl`
with the error "Stopped by you", so the report leaves it out of the medians. In a sweep, the race that
was cut off is left out of the table, the races that finished are kept, and the CSV is still written.
Closing the page does not stop a race; it only stops a sweep after the race in progress.

## Machine details

Open **MACHINE DETAILS** under the controls. For each machine picked above the page asks the
machine itself (`/props`, `/slots`, `/v1/models`) and shows its model file (never the folder it
sits in), the quantization read from that file name, the llama.cpp build, slots, context per slot,
trained context, image support and whether its chat template mentions thinking. A line under the
cards says where two machines differ. A machine that does not answer is shown as such, never as
zeros.

llama-server cannot report how it was started, so `-c`, `-ngl`, flash attention and speculative
decoding are not visible. Put them in `"notes"` on the lane and they are shown on the card and saved
with the results. The setup each machine reported when a race started is saved on every line of
`results/runs.jsonl` (`setup`) and in the last columns of the sweep CSV (`model_file`, `quant`,
`llama_cpp_build`, `slots`, `context_per_slot`, `machine_notes`), so a number found later still says
what produced it.

## Sweep: many races, one table

After a one-stream race with a prompt of 500 tokens or more, each finished tile also says
**PROMPT TAKEN IN**: the server's own prompt token count divided by the seconds to the first word.
That wait includes the first generated token, so it reads a little low; at 32K and up it is nearly
all prompt. It is shown, not ranked.

Open **SWEEP** under the controls. Pick prompt sizes, stream counts and a repeat count (1, 3 or 5),
and the machines picked above (head to head or one machine). **RUN SWEEP** runs every combination
one after another, as ordinary races you can watch, and fills in a table with, for each combination
and machine, the **median** of its runs with the lowest and highest in brackets:

| column | what it is |
|---|---|
| FIRST WORD | seconds to the first word |
| SPEED | one stream's tokens/sec (the median stream when there were several) |
| ALL STREAMS | every stream together, only with more than one stream |
| PROMPT TOK/S | prompt tokens ÷ seconds to first word. Blank where that would be a guess: several streams, a thinking model, a cache hit, no usage report, or a prompt under 500 tokens |
| TOTAL | seconds until everything finished |
| RUNS | runs finished / runs asked for. A failed run is left out of the medians, not counted as zero |

**WARM-UP** (on by default) runs one short race first and throws it away, so the first measured
run is not the one that wakes the model up. It is not in the table or in `runs.jsonl`.

A sweep is limited to 60 races, and the server waits 1.5 seconds between races. **DOWNLOAD CSV** saves
the table, and the server also writes it to `results/sweep-<time>.csv`, so a sweep left running
overnight is there in the morning. Every race in a sweep is also appended to `results/runs.jsonl`
like any other. Closing the page stops the sweep after the race in progress.

The same thing over HTTP, without the page:

```bash
curl -N -X POST http://localhost:9500/api/sweep -H 'content-type: application/json' \
  -d '{"presets":["4k","16k"],"concurrencies":[1,2],"repeats":3}'
```

## Engines

Any server with an OpenAI-compatible streaming endpoint can be raced. The machine details panel goes further for engines that report about themselves, and names the engine in the details, the run file, the CSV and the charts:

| Engine | How it is recognised | What is read |
| --- | --- | --- |
| llama.cpp (llama-server, llamafile) | `/props` | model file, quant, build, slots, context |
| vLLM | `/v1/models`, `/version`, `/metrics` | model, version, max sequences, context |
| Ollama | `/api/version`, `/api/tags`, `/api/ps` | version, quant, loaded context |
| LM Studio | `/api/v0/models` | GGUF or MLX, quant, loaded context |
| SGLang | `/get_server_info` | version, model, quant, max running requests, context |
| KoboldCpp | `/api/extra/version` | version |
| TGI | `/info` | version, model, max concurrent requests, context |
| TensorRT-LLM | `/v1/models` (`owned_by`) | name only |

Those endpoints were written from each engine's documentation, not tested against every version, so treat a "not reported" as "this server did not say", and open an issue with the output of that engine's status address if one is wrong.

A server that is not on the list (TensorFold, MLX-LM, LocalAI and others) still races. Type its name into **Engine** under MANAGE MACHINES, or set `"engine": "TensorFold"` on its lane in `race.config.json`; a typed name always wins over a detected one. Use **Notes** for how it was started.

THINKING LOW and OFF send each engine the switch it reads: `chat_template_kwargs` for most, `reasoning_effort` for Ollama. A lane's own `extraBody` always wins, so any engine's own switch can be set there.

### Fair comparison

- Every race starts with a unique run id as the first line of the prompt, so a server's prompt cache cannot hand one machine a head start. If a server still reports cached prompt tokens, the scoreboard says so and leaves prompt speed blank for it.
- If any machine does not report token counts, speed is shown in streamed chunks for all of them, and a note says so.
- A machine that writes only a few tokens is flagged, since a speed over three tokens means nothing.

## Charts and sharing results

When a race or a sweep finishes, a **RESULTS** bar appears under the controls with two buttons:

- **VIEW CHARTS** opens `/results.html` in a new tab. It draws bar charts of the machines side by side (first word, speed, total time, and throughput when there is more than one stream), plus line charts of how each number changes with prompt size and with streams per machine. Pick the prompt size and stream count at the top. Every chart has SAVE SVG and SAVE PNG.
- **DOWNLOAD DATA** saves the run as a `.json` file (`llm-super-bench-run`). It holds the numbers, the reply length and thinking setting, and each machine's model, quant and server build. It does **not** hold addresses or host names, so it is safe to send to someone.

On the results page, **ADD ANOTHER RUN FILE** loads a file someone else sent and draws their machines beside yours, labelled by file. **DOWNLOAD ALL SHOWN (.csv)** gives one spreadsheet of everything on screen. Run files are checked and cleaned when loaded; nothing in them is run.

The server keeps the latest finished run in memory (served at `/api/last-run`) and also writes each one to `results/run-<race|sweep>-<time>.json`. Restarting the server clears the in-memory copy; open a saved file from `results/` with ADD ANOTHER RUN FILE.

The original repo's charts were made differently: a small Python script (`scripts/charts.py`) wrote fixed SVG files from its `data/` folder. This page does the same kind of drawing live in your browser, from your own runs.

## Thinking models

**REPLY LENGTH** and **THINKING** at the top of the page set these for every machine, so nothing
here needs the config file. REPLY LENGTH is how many tokens each machine may write. THINKING **OFF**
asks every machine not to think (`chat_template_kwargs: {enable_thinking: false}`); **LOW** asks for the least reasoning the model offers (`reasoning_effort: low`, which
GLM-style templates read); **AUTO** leaves the model as it is. Both are saved to `race.config.json` and need the password. If a machine spends
its whole reply thinking and never answers, the page says so after the race. Each machine row under
MANAGE MACHINES also has **Streams at once**, for servers such as vLLM that cannot report it (leave it
empty for llama-server, which can).

A model that thinks first streams its reasoning before the answer. The harness labels that, and
leaves PROMPT TOK/S blank for it, because its first text is not the end of prompt processing.
To measure the prompt and the answer cleanly, switch thinking off for the race with `extraBody` on
the lane. For llama-server with a Qwen-style template that is
`"extraBody": {"chat_template_kwargs": {"enable_thinking": false}}`. Put the same setting on every
lane so the machines still get the same request. `extraBody` cannot set the model, messages,
streaming, token cap or temperature.

## Hosting and the password

Set `RACE_PASSWORD` (or `"password"` in `race.config.json`; the environment wins) and every request
needs it: the browser asks once, for any user name and that password.

```bash
RACE_PASSWORD='something-long' bun src/server.ts
```

This keeps other people on a shared network out of a page that can start races. It is not
encryption, so keep the port on your LAN or Tailscale and never open it to the internet.

To run it on the Mac Mini at boot, edit the four marked lines in
`deploy/com.reclaimednode.llmsuperbench.plist` (path to bun, harness folder, password, your user name),
then install it with the commands in the comment at the top of that file.

## Prompt presets

| Preset | Source text | Notes |
|--------|-------------|-------|
| Short  | none | one short question |
| 4K     | approx 4,096 tokens | 16,384 characters at the default 4 chars/token |
| 8K     | approx 8,192 tokens | 32,768 characters |
| 16K    | approx 16,384 tokens | 65,536 characters |
| 32K    | approx 32,768 tokens | 131,072 characters |
| 64K    | approx 65,536 tokens | 262,144 characters |
| 128K   | approx 131,072 tokens | 524,288 characters |

The token figures are approximations by definition, so the button tooltip and the log give the
exact character count too. Drop any `.txt` file into `prompts/` and point `promptFile` at it; the
tool trims it to size, repeating it if it is shorter than the target. `prompts/` is gitignored
apart from the two shipped texts (the CC0 sample and Mill's *On Liberty*, public domain). A size
the servers were not started with room for fails on the lane with the server's own error.

Every run prepends a unique `[race-run <id>]` line as the **first** line of the prompt, so a
server-side prompt cache has nothing to match and cannot hand one lane an unfair head start.

## What gets measured, and where

All timing happens in the bun server process on a monotonic clock. The browser only displays
what the server measured; nothing on the page times anything itself.

- **Start** — the instant before the request is written.
- **First response** — the first streamed line of any kind, *including* one carrying no text.
  Plenty of servers open with `{"role":"assistant","content":""}` the moment they accept the
  request.
- **First word** — the first streamed delta carrying non-empty text. It checks `delta.content`,
  `delta.reasoning` and `delta.reasoning_content`, and records **which** field it was. A model
  that streams its thinking first has not said its first word of reply, and the screen says so.
- **Speed** — see below.
- **Total** — start to end of stream.

Both arrival times are measured and both are logged, because a tool that treats an instant empty
chunk as the first word reports a first-word time of nearly zero. The big FIRST WORD clock on
screen is always the text-bearing one; first response is shown beside it in smaller type.

Every measurement drawn from one streamed line shares a single clock reading, taken the moment
the line is in hand — so the tool's own JSON parsing never lands inside a lane's number.

### The speed formula

```
speed = (count - 1) / (time of last piece - time of first piece)
```

Deliberately **not** `count / total time`. Total time includes the wait before the first word, so
dividing by it would understate the speed of whichever lane waited longest — punishing that lane
twice for one slow prefill, once in its first-word number and again in its speed. Two machines
that stream at an identical rate score identically here even if one took ten seconds longer to
start.

It is `count - 1` because N pieces have N-1 gaps between them, and the window being measured is
the gaps. A single piece has no window and therefore no speed.

The live readout uses the same formula over the pieces received so far, so the number on screen
during a race and the number in the scoreboard are the same measurement, not two.

`count` is real tokens when the endpoint reports usage and streamed chunks when it does not — and
the label next to the number always says which.

### Chunks are not tokens

Every request asks for `stream_options: {"include_usage": true}`. Before each race the tool
probes each endpoint to find out whether it actually answers with a `usage` block.

- Endpoint reports usage → real `completion_tokens`, and the readout says **tokens/sec**.
- Endpoint does not → the readout says **chunks/sec**, on screen and in the log, and the
  scoreboard adds a note saying why.

A streamed chunk is not a token, so the word "tokens" is never used for a chunk count. The
scoreboard only uses tokens/sec when *every* finishing lane reported real usage.

The pre-race probe doubles as a warm-up, which matters: on a cold model server the first request
pays the load cost, and warming every lane equally is the fair way to start.

## Output

Every lane of every race appends one line to `results/runs.jsonl` (gitignored):

```json
{"ts":"...","runId":"...","lane":"Desktop","baseUrl":"...","model":"...","preset":"8k",
 "promptChars":32873,"firstResponseSec":9.785838,"firstWordSec":9.785838,
 "firstWordField":"reasoning","lastWordSec":14.719,"chunks":255,"tokens":256,
 "tokenSource":"usage","totalSec":14.722216,"error":null}
```

`firstResponseSec` and `firstWordSec` are separate fields and are often different.
`lastWordSec` closes the speed window; a line logged before that field existed reports no speed
rather than a wrong one.

With more than one stream per machine, a lane's line carries three more fields, `concurrency`,
`failedStreams` and `streams` (one `{firstWordSec, lastWordSec, chunks, tokens, totalSec}` per
stream that finished), and its `firstWordSec` is the median of the streams, `lastWordSec` and
`totalSec` the latest, `chunks` and `tokens` the sum. The report works its speeds out from
`streams`, not from those summaries. A one-stream line has none of the three and is exactly what
it always was.

`bun run report` reads it back and prints medians per lane, preset **and streams per machine** —
a four-stream run is a different measurement from a one-stream run and is never pooled with it.
With several streams it adds an ALL STREAMS column beside SPEED, which is one stream's median.

## Failure is shown, not hidden

A lane that times out, refuses the connection, returns a bad status, or fails preflight shows the
reason on its own lane and in the race log. The other lanes keep racing, and the scoreboard scores
whoever finished while naming whoever did not.

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

## Layout

```
src/config.ts       load and validate race.config.json
src/prompt.ts       presets, trimming, run-id cache busting
src/timing.ts       the clock, the rate maths (speed, per-stream speed, throughput), the scoreboard
src/lane.ts         one stream: request, stream parse, every measured number
src/capacity.ts     asks a machine how many streams it runs at once (/props, or `slots` in the config)
src/editor.ts       changing the machines from the page: check an address, save the list
src/init.ts         `bun run init`: writes race.config.json from the machines' own answers
src/details.ts      what each machine reports about itself, and where they differ
src/sweep.ts        sweeps: a grid of races, medians per cell, CSV
src/auth.ts         the optional page password
src/streams.ts      several streams of one lane folded into one result; the stream-count options
src/request.ts      what the page may ask a race for: machines, size, streams
src/preflight.ts    model-list check and the usage probe
src/race.ts         starts every stream of every picked lane in the same tick, ticks the clocks
src/log.ts          results/runs.jsonl
src/report.ts       bun run report
src/server.ts       the one local server
src/mock.ts         fake lanes with dials for delay, speed, cache and prefill slope

src/bench/config.ts   bench.config.json, and the remote-value allow-pattern
src/bench/plan.ts     the grid, resume, the rough clock
src/bench/prompt.ts   sizing a prompt to a target, and the warm-up correction
src/bench/runner.ts   the grid engine
src/bench/stats.ts    median/low/high, and which runs may become numbers
src/bench/ssh.ts      managed mode's commands, as argument arrays
src/bench/engine.ts   mlx_lm.benchmark, and its parser
src/bench/store.ts    the run folder
src/bench/report.ts   report.md
src/bench/board.ts    shaping a run for the board
src/bench/power.ts    the wall-meter pass
src/bench/cli.ts      bun run bench
src/bench/setup.ts    preparing a machine: uv, pinned envs, models at one path
src/bench/setupreport.ts  what setup-lane prints
src/bench/setupcli.ts bun run setup-lane
src/bench/image.ts    the image grid: plan, mflux commands, shim output
src/bench/imagestats.ts  image cell medians and checksum agreement
src/bench/imagerunner.ts the image run loop
src/bench/imagecli.ts bun run imagebench
remote/mflux_bench.py the timing shim that separates load from generate
remote/beat11/        the Resolve local-AI edit: its two prompts, the Kev judge, the MCP helpers
src/bench/video.ts    the video grid: pinned port, commands, parsing
src/bench/videocli.ts bun run videobench
src/bench/clip.ts     one clip per Mac, and the picture a clip can start from
src/bench/clipcli.ts  bun run clip
src/show/run.ts       the tests page: which tests, what a run does, what may be served
src/show/stats.ts     the live strip: macmon per lane, started and stopped by the page
src/show/server.ts    bun run show

public/             the race page: index.html, style.css, app.js
public/bench/       the progress page, the board, the power page, bench.css
```

The two modes share the lane client, the clock, the rate maths, the mock and the palette. The
race does not know the benchmark exists.

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


## Credits

LLM-Super-Bench is built on **LLM Race**, the harness in
[theNetworkChuck/mac-studio-m5-ultra-local-ai](https://github.com/theNetworkChuck/mac-studio-m5-ultra-local-ai)
by NetworkChuck, released under the MIT License. The race itself, the scoreboard, the timing rules and
the on-screen design come from that project. Thank you to NetworkChuck for building it and sharing it.

What this version adds is listed in [NOTICE.md](NOTICE.md). The original repository's data, writing and
media are under their own licences and are not part of this one.
