#!/usr/bin/env bash
# The full head-to-head plan for a blog post, run unattended with the tools already in this repo.
# Every step is an ordinary `bun run sweep` or `bun run quality`, so the results land in results/ and
# show up on the page under VIEW CHARTS / SAVED ON THIS SERVER like any other run.
#
#   RACE_CONFIG=race.config.dsv41.json ./scripts/head-to-head.sh            # everything
#   RACE_CONFIG=race.config.dsv41.json ./scripts/head-to-head.sh speed      # one part
#   RACE_CONFIG=race.config.dsv41.json ./scripts/head-to-head.sh speed long quality
#
# Parts:
#   speed    short/4K/16K prompts x 1,2,4,8,16 streams, 3 runs each (45 races)
#   long     32K/64K prompts x 1,2,4 streams, 2 runs each (12 races), then 128K x 1 stream, 2 runs
#   quality  GSM8K 200, IFEval 100, MMLU-Pro 200, long-context fact finding at 8K/32K/128K
#
# Settings (environment):
#   MACHINES     machine names to race, comma separated (default: every machine in the config)
#   THINKING     off | low | auto            (default off: same work on every machine, clean prompt timing)
#   MAX_TOKENS   reply length for the speed parts (default 512)
#   Q_TOKENS     reply length for the quality parts (default 2048)
#   REPEATS      runs per cell for the speed part (default 3)
#
# A sweep is capped at 60 races, which is why the grid is split into parts. Each part exits on its own
# failure without stopping the parts after it; the summary at the end says which ones did not finish.
set -uo pipefail
cd "$(dirname "$0")/.."

THINKING="${THINKING:-off}"
MAX_TOKENS="${MAX_TOKENS:-512}"
Q_TOKENS="${Q_TOKENS:-2048}"
REPEATS="${REPEATS:-3}"
PARTS=("$@")
[ ${#PARTS[@]} -eq 0 ] && PARTS=(speed long quality)

if [ -n "${RACE_CONFIG:-}" ]; then
  [ -f "$RACE_CONFIG" ] || { echo "RACE_CONFIG=$RACE_CONFIG does not exist."; exit 2; }
  echo "Using machines from $RACE_CONFIG"
else
  echo "Using machines from race.config.json (set RACE_CONFIG to use another file)"
fi

machines=()
[ -n "${MACHINES:-}" ] && machines=(--machines "$MACHINES")
failed=()

step() {
  local name="$1"; shift
  echo
  echo "=== $name ($(date '+%H:%M'))"
  if ! "$@"; then
    failed+=("$name")
    echo "!!! $name did not finish"
  fi
}

have() { [ -f "quality/$1/data.jsonl" ] || [ "$1" = ifeval ]; }

for part in "${PARTS[@]}"; do
  case "$part" in
    speed)
      step "speed: short/4K/16K x 1-16 streams" \
        bun run sweep --sizes short,4k,16k --streams 1,2,4,8,16 --repeats "$REPEATS" \
          --thinking "$THINKING" --max-tokens "$MAX_TOKENS" "${machines[@]}"
      ;;
    long)
      step "long: 32K/64K x 1,2,4 streams" \
        bun run sweep --sizes 32k,64k --streams 1,2,4 --repeats 2 \
          --thinking "$THINKING" --max-tokens "$MAX_TOKENS" "${machines[@]}"
      step "long: 128K x 1 stream" \
        bun run sweep --sizes 128k --streams 1 --repeats 2 --no-warmup \
          --thinking "$THINKING" --max-tokens "$MAX_TOKENS" "${machines[@]}"
      ;;
    quality)
      for s in gsm8k mmlu-pro; do
        have "$s" || step "download $s questions" bun run quality:fetch "$s"
      done
      step "quality: GSM8K (200)" bun run quality --suite gsm8k --limit 200 --thinking "$THINKING" --max-tokens "$Q_TOKENS" --streams 4 "${machines[@]}"
      step "quality: IFEval (100)" bun run quality --suite ifeval --limit 100 --thinking "$THINKING" --max-tokens "$Q_TOKENS" --streams 4 "${machines[@]}"
      step "quality: MMLU-Pro (200)" bun run quality --suite mmlu-pro --limit 200 --thinking "$THINKING" --max-tokens "$Q_TOKENS" --streams 4 "${machines[@]}"
      step "quality: long-context 8K/32K/128K" bun run quality --suite longctx --sizes 8k,32k,128k --thinking "$THINKING" --max-tokens "$Q_TOKENS" "${machines[@]}"
      ;;
    *)
      echo "Unknown part \"$part\". Parts: speed, long, quality."; exit 2 ;;
  esac
done

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "All parts finished. Open the page and press VIEW CHARTS, or load the files in results/ on the results page."
else
  echo "Finished, but these did not complete: ${failed[*]}"
  echo "Their partial results are still in results/. Re-run just that part, e.g. ./scripts/head-to-head.sh long"
  exit 1
fi
