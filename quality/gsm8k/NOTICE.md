# GSM8K: notice

The questions of **GSM8K** are not stored in this repository by default. `bun run quality:fetch gsm8k`
downloads them, unchanged, into this folder as `data.jsonl`, checks that they are the full set
and in the shape this tool reads, and writes `SOURCE.txt` with the date and a SHA-256 fingerprint.

- What it is: 1,319 grade-school maths word problems; the answer is the number after `####`.
- Paper: Cobbe et al. (OpenAI), *Training Verifiers to Solve Math Word Problems*, 2021, <https://arxiv.org/abs/2110.14168>
- Data: <https://huggingface.co/datasets/openai/gsm8k>
- Licence: MIT (stated on the dataset card)

The answer-checking code (`src/quality/math.ts`) is written for this project. The questions are asked zero-shot with one
standard instruction, so a score here is for comparing your machines with each other. It is not the
few-shot setup some leaderboards use and should not be compared with one to the decimal.

If you publish a score, say it is **GSM8K**, how many questions you asked (`--limit`), the reply limit and the
thinking setting; the saved results file records all of these.

The downloaded `data.jsonl` is large and is left out of git by default (see `.gitignore`). If you want to commit it,
keep this notice beside it.
