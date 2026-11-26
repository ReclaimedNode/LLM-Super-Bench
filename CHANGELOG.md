# Changelog

## Unreleased

- **Sustained streams.** A sweep over two or more stream counts now ends with the most streams each machine carried
  cleanly at each prompt size: every run finished, no stream failed, and no more streams than the machine runs at once.
  The climb stops at the first stream count that was not clean and says what was wrong there. When nothing failed the
  figure is said as "at least". Shown under the sweep table, printed by `bun run sweep`, saved in the run file
  (`sustained`) and listed on the results page and in the downloaded report.
- **Memory during a sweep.** MEMORY in the sweep panel, `bun run sweep --memory`, or `MEMORY=on` for
  `scripts/head-to-head.sh` samples each machine's host and GPU memory once a second while the races run, over ssh,
  with a read-only loop and nothing installed (Linux: `/proc/meminfo` and `nvidia-smi`; macOS: `vm_stat`). Each row
  carries the peak over its runs. New PEAK MEMORY column, two results-page charts (host and GPU memory at peak), and
  the memory at a failing stream count is stated in the sustained-streams sentence. A machine that cannot be sampled
  is named with the reason and left blank; the sweep is not affected. Off by default.
- Sweep rows, the sweep CSV and the results page's CSV gain `failed_streams`, `host_mem_peak_gb`, `host_mem_total_gb`,
  `gpu_mem_peak_gb`, `gpu_mem_total_gb`, `swap_peak_gb` and `memory_samples`, placed after the total-time columns and
  before `engine`. Anything reading the CSV by column position after `total_sec_max` needs to read by name instead.
  The RUNS column says when streams failed inside a run that finished.
- A machine's `ssh` block (`host`, `user`, `sshPort`, `binDir`) in `race.config.json` is now kept when the config is
  loaded and when machines are saved from the page. Before, saving from the page dropped it.

- `RACE_CONFIG=<file>` points every command (`race`, `sweep`, `quality`, `lanes`, `init`, the page's saves) at another
  machines file for that run, so a second set of machines can live beside `race.config.json` instead of replacing it.
  Relative names are read from the project folder. `race.config.*.json` is gitignored like `race.config.json`;
  `race.config.*.example.json` files are kept.
- `scripts/head-to-head.sh` runs a full head to head unattended: short/4K/16K at 1-16 streams, 32K/64K at 1-4 streams,
  128K at one stream, then GSM8K, IFEval, MMLU-Pro and the long-context test. The grid is split so no sweep passes the
  60-race limit. Choose parts (`speed`, `long`, `quality`) and settings (`MACHINES`, `THINKING`, `MAX_TOKENS`,
  `Q_TOKENS`, `REPEATS`) from the command line.
- `race.config.dsv41.example.json`: a starting point for DeepSeek V4.1 Flash on a vLLM machine against a Mac Studio
  on oMLX, with long timeouts for 64K and 128K prompts.

## 1.0.0 (2026-11-01)

The first tagged release. The numbers used before it (1.0.0 and 1.1.0 in `package.json`) were never tagged, and
everything they covered is listed here, newest first. Run files made before this release record version 1.1.0;
tell them apart by the commit they also record.

- Head to head now races exactly two machines. With more than two saved, buttons under MACHINES pick which two (and which one for SOLO); the pick is remembered in the browser. Before, head to head raced every saved machine at once. Saving machines from MANAGE MACHINES no longer drops machines past the two rows it shows.
- COMPARE RUN FILES moved into the header, as a RESULTS control beside MACHINES.
- **COMPARE RUN FILES** on the race page opens `/results.html?compare`, a results tab that starts empty and shows only the run files you add, so a file someone sent you is not drawn beside this server's latest run unless you add it. On the normal results page, this server's run can now be removed with its × like any other file.

- mlx-vlm and mlx-lm (`mlx_lm.server`) are recognised. mlx-vlm: version (from its `Server` header), loaded model,
  MLX bit width, context and whether a speculative drafter is loaded. mlx-lm: model and bit width. A path ending in a
  bit-width folder is shown with its parent (`Foo-MLX/8-bit`, not `8-bit`). Preflight refuses a lane set to a model
  mlx-vlm lists but has not loaded, since asking for it would swap models mid-race. `bun run probe` now shows the
  `Server` header and asks `/v1/settings`.
- Fixed: merging two image (or clip) runs failed with "Target already exists" because the second run's folder was
  copied onto the first's. Files are now copied one by one, and a real clash between two files still stops the merge.
- Tests: the image shim tests carry a stand-in for MLX's memory reading and use an output path no one can create,
  so they pass on any machine, including one without MLX and one running as root.
- Sampling is now a setting, saved with every result. TEMPERATURE on the page (0 by default), `--temperature`,
  `--top-p` and `--top-k` on `bun run sweep`, and `topP` / `topK` in `race.config.json`. top_p and top_k are sent
  only when set. Above temperature 0 with either unset, the page and the sweep warn that each server will use its own
  default (vLLM reads the model's `generation_config.json`, llama.cpp has its own), so the machines may sample
  differently. Run files, the sweep CSV, the results page's setup table and its CSV now record temperature, top_p and
  top_k, and the results page says when loaded files were sampled differently. A machine's `extraBody` may no longer
  set `top_p` or `top_k`.
- `quality:fetch` downloads more gently and can use an optional `HF_TOKEN` (free Hugging Face token) when Hugging Face limits downloads.
- `bun run quality` asks every machine the questions of a published test and scores whether the answers are right.
  Tests: IFEval (instructions, 541 questions), MMLU-Pro and MMLU (knowledge), GSM8K and MATH-500 (maths), and a long-context
  test (needle, multi-key, variable chain) made here. `bun run quality:fetch <test>` downloads the questions unchanged,
  checks them and records a fingerprint. Strict and loose scores, results by subject or by kind and size, cut-off and
  thinking-only replies counted separately, saved to `results/quality-<time>.json`. See `quality/<test>/NOTICE.md` for sources and licences.
- The mock server answers `stream: false` requests.
- `bun run update`: a safe `git pull` that explains itself. It takes what is new, and when you and GitHub both have changes it says so, changes nothing and offers `--merge`, which undoes itself if the two clash. The update banner now points to it. See README, Updating.
- `bun run quality` prints each machine's name, model and engine (never its address) before it starts.
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
- First release as LLM-Super-Bench, based on NetworkChuck's LLM Race harness: solo and head-to-head, selectable prompt
  sizes and stream counts, sweeps with CSV, machine details, editable machines, reply length and thinking controls.
