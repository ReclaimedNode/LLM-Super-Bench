# MMLU-Pro: notice

The questions of **MMLU-Pro** are not stored in this repository by default. `bun run quality:fetch mmlu-pro`
downloads them, unchanged, into this folder as `data.jsonl`, checks that they are the full set
and in the shape this tool reads, and writes `SOURCE.txt` with the date and a SHA-256 fingerprint.

- What it is: 12,032 questions, 10 options each, across 14 subjects. Built from MMLU with harder, more options.
- Paper: TIGER-Lab, Wang et al., *MMLU-Pro: A More Robust and Challenging Multi-Task Language Understanding Benchmark*, 2024, <https://arxiv.org/abs/2406.01574>
- Data: <https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro>
- Licence: MIT (the dataset card's licence field)

The answer-checking code (`src/quality/mc.ts`) is written for this project. The questions are asked zero-shot with one
standard instruction, so a score here is for comparing your machines with each other. It is not the
few-shot setup some leaderboards use and should not be compared with one to the decimal.

If you publish a score, say it is **MMLU-Pro**, how many questions you asked (`--limit`), the reply limit and the
thinking setting; the saved results file records all of these.

The downloaded `data.jsonl` is large and is left out of git by default (see `.gitignore`). If you want to commit it,
keep this notice beside it.
