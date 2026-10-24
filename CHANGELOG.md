# Changelog

## Unreleased

- `quality:fetch` downloads more gently and can use an optional `HF_TOKEN` (free Hugging Face token) when Hugging Face limits downloads.
- `bun run quality` asks every machine the questions of a published test and scores whether the answers are right.
  Tests: IFEval (instructions, 541 questions), MMLU-Pro and MMLU (knowledge), GSM8K and MATH-500 (maths), and a long-context
  test (needle, multi-key, variable chain) made here. `bun run quality:fetch <test>` downloads the questions unchanged,
  checks them and records a fingerprint. Strict and loose scores, results by subject or by kind and size, cut-off and
  thinking-only replies counted separately, saved to `results/quality-<time>.json`. See `quality/<test>/NOTICE.md` for sources and licences.
- The mock server answers `stream: false` requests.
- `bun run update`: a safe `git pull` that explains itself. It takes what is new, and when you and GitHub both have changes it says so, changes nothing and offers `--merge`, which undoes itself if the two clash. The update banner now points to it. See README, Updating.
- `bun run quality` prints each machine's name, model and engine (never its address) before it starts.

## 1.1.0

- Fixed: the differences listed under Machine details were dark text on a dark panel and hard to read. They are now light.

- Charts page (`/results.html`) with bar and line charts, SVG and PNG export, a CSV of everything shown, and a
  self-contained HTML report you can post or send. Saved runs on the server can be added from a list.
- Run files (`.json`) you can share and load beside your own. They carry no addresses.
- Engines: llama.cpp, vLLM, Ollama, LM Studio, SGLang, KoboldCpp, TGI, TensorRT-LLM and Strata are recognised;
  others can be named by hand (for example TensorFold). The right thinking switch is sent per engine.
- `bun run probe <url>` prints what a machine's status addresses answer, for fixing "not reported".
- `bun run sweep` runs a sweep from the command line (for schedules and headless machines).
- Optional watts per machine, for a speed-per-watt chart (the number is yours; it is not measured here).
- Scoreboard warns when a server reused cached prompt tokens or wrote almost nothing.
- Security: other websites cannot act through a saved password, a request size cap, a lockout after repeated wrong
  passwords, browser security headers, and a startup warning when no password is set.
- Update notice (never auto-update) and a README split: the inherited suite's docs moved to `docs/`.
- Run files and the sweep CSV record the reply length, thinking setting and tool version.

## 1.0.0

- First release as LLM-Super-Bench, based on NetworkChuck's LLM Race harness: solo and head-to-head, selectable prompt
  sizes and stream counts, sweeps with CSV, machine details, editable machines, reply length and thinking controls.
