# Notice

LLM-Super-Bench is a modified version of the `harness/` folder of
[theNetworkChuck/mac-studio-m5-ultra-local-ai](https://github.com/theNetworkChuck/mac-studio-m5-ultra-local-ai),
which is released under the MIT License (see `LICENSE`, which keeps the original copyright notice).

Added or changed here: choosing one machine or head to head; prompt sizes up to 128K; streams per
machine, limited to what each machine reports it can run; prompt-processing speed; sweeps with
repeats, medians and CSV; machine details and setup recorded with every result; a STOP button; a
password option; editing the machines from the page; `bun run init`; a launchd service file for macOS.

The measurements, writing, charts and media in the original repository (`data/`, `docs/`, `assets/`,
`media/`, `site/`) are under their own licences and are not part of this project.
