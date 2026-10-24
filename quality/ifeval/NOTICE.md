# IFEval: notice

The questions in this folder (`input_data.jsonl`) and the idea of scoring a model by rules a
program can check come from **IFEval**, made by Google Research:

- Paper: Zhou et al., *Instruction-Following Evaluation for Large Language Models*, 2023,
  <https://arxiv.org/abs/2311.07911>
- Source: <https://github.com/google-research/google-research/tree/master/instruction_following_eval>
- Data: <https://huggingface.co/datasets/google/IFEval>
- Copyright 2026 The Google Research Authors. Licensed under the **Apache License, Version 2.0**.
  The licence text is kept beside the data as `LICENSE-APACHE-2.0.txt`.

## What is here and what was changed

- `input_data.jsonl` is Google Research's file, **not changed in any way**, so a score here
  means the same as a score anywhere. `bun run quality:fetch` downloads it from the source above,
  checks it holds the 541 questions in the right shape, and saves it here with the licence.
- The checking code, `src/quality/ifeval.ts`, is **a TypeScript port written for this project**
  after Google Research's Python `instruction_following_eval` code. It is changed from the original:
  it runs on Bun with no libraries, so the language guess (the rules that ask for a response
  language, or for English capitals or lowercase) uses writing system and common words
  instead of the `langdetect` library, and sentence counting uses a simple splitter instead of
  `nltk`. A text on the border of a rule can score differently from Google's code, so do not
  compare a score from here to one made with Google's code to the decimal.
- `test/quality/ifeval-sample.jsonl` holds the first three questions of the same file, unchanged,
  for the tests.

The rest of LLM-Super-Bench is under the MIT licence (see `LICENSE`). This folder and the IFEval
port are under the Apache License 2.0 as above.

## If you publish a score

Say it is **IFEval**, how many questions were asked (`--limit`), the reply limit and the thinking
setting. The saved results file records all of these.
