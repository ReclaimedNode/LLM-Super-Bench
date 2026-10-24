# MATH-500: notice

The questions of **MATH-500** are not stored in this repository by default. `bun run quality:fetch math500`
downloads them, unchanged, into this folder as `data.jsonl`, checks that they are the full set
and in the shape this tool reads, and writes `SOURCE.txt` with the date and a SHA-256 fingerprint.

- What it is: 500 competition maths problems with a final answer.
- Paper: Lightman et al. (OpenAI), *Let's Verify Step by Step*, 2023, <https://arxiv.org/abs/2305.20050>, which took 500 test problems from Hendrycks et al.'s MATH, <https://arxiv.org/abs/2103.03874>
- Data: <https://huggingface.co/datasets/HuggingFaceH4/MATH-500>
- Licence: **Not stated on the Hugging Face card.** The source repository openai/prm800k is MIT-licensed. The MATH dataset's own licence was not re-checked here. Confirm it before you commit the data to a public repository; the default `.gitignore` leaves it out.

The answer-checking code (`src/quality/math.ts`) is written for this project. The questions are asked zero-shot with one
standard instruction, so a score here is for comparing your machines with each other. It is not the
few-shot setup some leaderboards use and should not be compared with one to the decimal.

If you publish a score, say it is **MATH-500**, how many questions you asked (`--limit`), the reply limit and the
thinking setting; the saved results file records all of these.

The downloaded `data.jsonl` is large and is left out of git by default (see `.gitignore`). If you want to commit it,
keep this notice beside it.
