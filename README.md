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

## Updating

On the machine that runs it:

```bash
cd ~/LLM-Super-Bench
bun run update
```

then restart the server. `bun run update` is a safe `git pull`: it lists what is new, takes it, and tells you in plain words if it cannot.
It changes nothing it was not asked to, and it never leaves you at a Git prompt.

- **"You and GitHub each have changes the other does not"** means you committed inside this folder (for example the downloaded IFEval
  questions) while GitHub also moved on. Nothing was changed. Run `bun run update --merge` to keep both; if your changes clash with
  the new ones it undoes itself and names the files. Send your own commits to GitHub afterwards with `git push`, or leave them local.
- **Files you edited but did not commit** are kept. If they clash with the update it stops and changes nothing; copy them aside,
  update, and put them back. Your `race.config.json` is never touched, because it is not tracked by Git.
- **A zip download** cannot update itself: download the new version and copy your `race.config.json` into it.
- Plain `git pull` also works. If Git says "divergent branches", you are in the first case: use `git pull --no-rebase` to keep both.

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
  "temperature": 0,        // sent to every machine; 0 is greedy, the fair setting for a speed race
  // "topP": 0.95, "topK": 20,   // optional; sent only when set. Set both whenever temperature is above 0
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
| Strata | `/health` (`max_context`, `loaded`) | model, context, image support |
| TensorRT-LLM | `/v1/models` (`owned_by`) | name only |

Those endpoints were written from each engine's documentation, not tested against every version, so treat a "not reported" as "this server did not say", and open an issue with the output of that engine's status address if one is wrong.

Strata listens on `127.0.0.1` by default. To race it from another computer, start it with `--host 0.0.0.0 --api-key <secret>` and put the same key as `"apiKey"` on its lane in `race.config.json`.

A server that is not on the list (TensorFold, MLX-LM, LocalAI and others) still races. Type its name into **Engine** under MANAGE MACHINES, or set `"engine": "TensorFold"` on its lane in `race.config.json`; a typed name always wins over a detected one. Use **Notes** for how it was started.

THINKING LOW and OFF send each engine the switch it reads: `chat_template_kwargs` for most, `reasoning_effort` for Ollama and Strata. A lane's own `extraBody` always wins, so any engine's own switch can be set there.

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

### More ways to use the charts

- **Report.** On the results page, **DOWNLOAD REPORT (.html)** saves one file with every chart and the setup table in it. It has no scripts and fetches nothing, so you can attach it, host it, or paste its charts into a post.
- **Saved runs.** Everything that finishes is saved in `results/`. The results page lists them under **SAVED ON THIS SERVER**, so you can compare today's run with last week's without finding the file.
- **Tool version.** Each run file records the version and commit of the tool that made it. If you load files from different versions, the page warns that timing rules may differ.
- **Speed per watt.** Measure what a machine draws under load with a wall meter or smart plug, then enter it under **MANAGE MACHINES** (or `"watts": 320` on the machine in `race.config.json`). The charts then add a tokens-per-second-per-watt chart. The watts are your number, and the tool does not measure power. The chart needs real token counts, not streamed chunks.

## Command line

```bash
bun run sweep --sizes short,4k,16k --streams 1,2,4 --repeats 3      # the page's sweep, no browser needed
bun run sweep --machines "Mac Studio,CMP 170HX" --thinking low --max-tokens 1024
bun run probe http://192.168.1.50:8000                              # what a machine's status addresses say
```

`bun run sweep` writes the CSV and the shareable run file to `results/`, then you open the page (or the results page) to see the charts. Options: `--sizes`, `--streams`, `--repeats`, `--machines` (by name), `--no-warmup`, `--thinking auto|low|off`, `--max-tokens`, and `--temperature` / `--top-p` / `--top-k` for that sweep only (see Sampling). It exits 0 when the sweep finished, so it fits a scheduled job.

`bun run probe` is read-only (it only sends GET requests). Use it when MACHINE DETAILS says "not reported": the output masks addresses and home folders and is safe to paste into an issue.

## Are the answers right? `bun run quality`

A race measures speed, not whether the answers are any good. `bun run quality` asks every machine the questions of a
published test and scores the answers with code. No second model judges anything.

| Test (`--suite`) | Measures | Questions | Source and licence |
|---|---|---|---|
| `ifeval` (default) | Following instructions a program can check ("no commas", "at least 300 words") | 541 | Google Research, Apache 2.0 |
| `mmlu-pro` | Knowledge and reasoning, 10-option multiple choice, 14 subjects | 12,032 | TIGER-Lab, MIT |
| `mmlu` | General knowledge, 4-option multiple choice, 57 subjects | 14,042 | Hendrycks et al., MIT |
| `gsm8k` | Grade-school maths, final number checked | 1,319 | OpenAI, MIT |
| `math500` | Competition maths, final answer checked after normalising | 500 | OpenAI / Hendrycks et al. (see its notice) |
| `longctx` | Finding facts buried in 4K to 128K tokens: needle, multi-key, variable chain | made here | after RULER (Apache 2.0) and needle-in-a-haystack (MIT) |

```bash
bun run quality:fetch ifeval          # once per published test: downloads the questions unchanged, checks them
bun run quality --limit 60            # IFEval, an even spread of 60 of the 541 questions
bun run quality:fetch mmlu-pro && bun run quality --suite mmlu-pro --limit 200
bun run quality --suite longctx --sizes 8k,32k,128k      # nothing to download
bun run quality --machines "Mac Studio,CMP 170HX" --max-tokens 2048 --thinking off --streams 4
```

Downloads work without an account. If Hugging Face slows you down (HTTP 429), make a free read-only token at
huggingface.co/settings/tokens and run `HF_TOKEN=hf_yourtoken bun run quality:fetch all`. The token is only sent to
Hugging Face's row service and is never saved or printed. To keep it out of your command history, `export HF_TOKEN=...`
in your shell profile instead.

- Every machine gets the same questions, temperature 0, the same reply limit and the same thinking switch as a race.
- **Strict** counts the answer as the test defines it ("The answer is (B)", `\boxed{}`, every rule followed). **Loose** forgives the
  format (a bare "Answer: B", the last number in the reply, "Sure, here it is:" in front). The headline is strict.
- A reply cut off by the reply limit, or one that is only the model's thinking, is counted separately (CUT OFF, ONLY
  THINKING) so you can tell a model that ran out of room from one that got it wrong. Raise `--max-tokens` for a thinking model.
- The saved `results/quality-<time>.json` holds the machine setups, settings, scores, a table by subject or by kind and size, and
  the start of each answer. It holds no addresses.
- The published questions are kept exactly as their authors released them, with a notice in `quality/<test>/` and a
  SHA-256 fingerprint in `SOURCE.txt`. The checking code is ours. Questions are asked **zero-shot with one standard instruction**,
  which is not the few-shot setup of some leaderboards, so compare your machines with each other, not to a leaderboard to the decimal.
  IFEval's language guess and MATH-500's answer matching are rougher than the originals (an answer written in an unusual form can be
  marked wrong). Say which test and how many questions you asked whenever you publish a score.
- The long-context test needs a machine whose context fits the size: a prompt that does not fit comes back as an error (NO REPLY).
- MMLU-Pro and MMLU are large; use `--limit`. The downloaded `data.jsonl` files are left out of git by default.

These tests measure following instructions, knowledge, maths and finding facts in long text. They do not measure coding, tool
use, writing quality or truthfulness, and a high score on one is not a verdict on a model.

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
streaming, token cap or sampling (temperature, top_p, top_k).

### Sampling

Every request carries the race's `temperature`, 0 by default. At 0 every machine picks its most likely
word, which is the fair setting for a speed race: speculative decoding accepts more drafted words when
the output is predictable, so a different temperature can change speed as well as wording.

Change it with TEMPERATURE on the page, `"temperature"` in `race.config.json`, or for one sweep only
with `bun run sweep --temperature 0.7 --top-p 0.95 --top-k 20` (`--top-p none` leaves that setting to
each server). `top_p` and `top_k` are sent only when set. Above temperature 0, set both: a server left
to choose uses its own default (vLLM reads the model's `generation_config.json`, llama.cpp has its
own), so two machines would sample differently. The page and the sweep warn when that would happen.

The sampling is saved in every run file and CSV and shown in the results page's setup table, and the
results page says when the files you loaded were sampled differently.

## Security

What the page protects against, and what it does not.

- **Keep it on a trusted network.** The password is HTTP Basic over plain HTTP, so it crosses the network unencrypted. Use a home LAN or a private network such as Tailscale. Do not open the port to the internet. If you must reach it from outside, put it behind a reverse proxy that adds HTTPS.
- **Set `RACE_PASSWORD`.** Without it anyone on the network can start races. Changing machines or settings from the page is refused without one.
- **Other websites cannot act for you.** Any request that changes something must come from this page itself. A request from another site in your browser is refused, even with your password saved.
- **Password guessing is slowed.** After 10 wrong passwords an address is locked out for 5 minutes.
- **Small requests only.** Anything over 64 KB is refused, and every page carries headers that stop framing, sniffing and scripts from anywhere but this server.
- **No addresses leave the machine in the data you share.** Run files and the results page carry no host names, addresses or folders, and files you load are checked and escaped before they are drawn.
- **Config stays private.** `race.config.json` (addresses, API keys) is never committed.
- **Update notice, not auto-update.** The page asks GitHub (one anonymous request, at most once a day) whether this repository has a newer version, and shows a banner if so. It never pulls or installs anything; you run `bun run update` (see [Updating](#updating)) and restart yourself. It sends only the repository name and the commit you are on. Turn it off with `LLM_SUPER_BENCH_NO_UPDATE_CHECK=1`. It stays silent for a zip download, with no internet, or if GitHub does not answer.
- **Not covered:** the extra pages (`bun run show`, `board`, `power`) are read-only but have no password. Run them only on a trusted network.

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

## More tools (inherited)

The repository also carries the wider benchmark suite from the original project: a grid benchmark with a results
board, image and video benchmarks, one-clip and daily runners, power logging and a show screen. They are not needed for
racing, sweeping or charts. Their documentation is in [docs/inherited-suite.md](docs/inherited-suite.md), and the
original project is at [theNetworkChuck/mac-studio-m5-ultra-local-ai](https://github.com/theNetworkChuck/mac-studio-m5-ultra-local-ai).

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

## Credits

LLM-Super-Bench is built on **LLM Race**, the harness in
[theNetworkChuck/mac-studio-m5-ultra-local-ai](https://github.com/theNetworkChuck/mac-studio-m5-ultra-local-ai)
by NetworkChuck, released under the MIT License. The race itself, the scoreboard, the timing rules and
the on-screen design come from that project. Thank you to NetworkChuck for building it and sharing it.

What this version adds is listed in [NOTICE.md](NOTICE.md). The original repository's data, writing and
media are under their own licences and are not part of this one.

The quality tests use **IFEval** (Google Research, Apache 2.0), **MMLU-Pro** (TIGER-Lab, MIT), **MMLU** (Hendrycks et al., MIT),
**GSM8K** (OpenAI, MIT) and **MATH-500** (OpenAI, from Hendrycks et al.), and a long-context test modelled on **RULER** (NVIDIA,
Apache 2.0) and needle-in-a-haystack (Kamradt, MIT). Sources, papers and licences are in each `quality/<test>/NOTICE.md`.
