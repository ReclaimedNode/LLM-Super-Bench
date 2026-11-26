# Notice

LLM-Super-Bench is a modified version of the `harness/` folder of
[theNetworkChuck/mac-studio-m5-ultra-local-ai](https://github.com/theNetworkChuck/mac-studio-m5-ultra-local-ai),
which is released under the MIT License (see `LICENSE`, which keeps the original copyright notice).

Added or changed here: choosing one machine or head to head; prompt sizes up to 128K; streams per
machine, limited to what each machine reports it can run; prompt-processing speed; sweeps with
repeats, medians and CSV; machine details and setup recorded with every result; a STOP button; a
password option; editing the machines from the page; `bun run init`; a launchd service file for macOS.

Also added here: sustained streams (the most streams a machine carried cleanly in a sweep) and memory sampling
during a sweep. Both ideas follow the CROWD test of [Agent Headroom](https://github.com/alexziskind1/agent-headroom)
(Apache-2.0), which climbs agent counts until a turn fails while sampling host and GPU memory. No code or data
from that project is used, and these results are not Agent Headroom results.

The measurements, writing, charts and media in the original repository (`data/`, `docs/`, `assets/`,
`media/`, `site/`) are under their own licences and are not part of this project.

Also added: `bun run quality`, which asks each machine the questions of a published test and scores the answers:
**IFEval** (Google Research, Apache License 2.0), **MMLU-Pro** (TIGER-Lab, MIT), **MMLU** (Hendrycks et al., MIT),
**GSM8K** (OpenAI, MIT) and **MATH-500** (OpenAI, from Hendrycks et al.'s MATH), plus a long-context test written here after
RULER (NVIDIA, Apache-2.0) and needle-in-a-haystack (Kamradt, MIT). The questions are downloaded unchanged by
`bun run quality:fetch`; the checking code is written for this project. Each test has a `NOTICE.md` in `quality/<test>/`.
