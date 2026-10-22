/**
 * The pinned toolchain. Every version this project installs is in this file.
 *
 * It is one file on purpose: bumping a benchmark's software is a decision, and
 * a decision should be a one-line change somewhere obvious rather than a hunt
 * through the code that happens to install things. Changing a line here is
 * enough -- `setup-lane` rebuilds any environment whose installed versions no
 * longer match, on every machine, so the lanes stay comparable with each other.
 *
 * A pin is the whole point of the exercise. "Latest on both machines" is not a
 * control, it is a coincidence: two machines set up a week apart would be
 * running different software and the difference would be read as hardware.
 */

import type { ModelKind } from "./types.ts";

export interface Pin {
  /** Folder under ~/bench-envs. */
  dir: string;
  /** Exactly what gets installed, versions and all. */
  packages: string[];
  /** The interpreter uv builds the environment on, so both machines match. */
  python: string;
  /** Why these versions, for whoever reads this next. */
  why: string;
}

export const PINS: Record<ModelKind, Pin> = {
  /**
   * mlx 0.32.2 (2026-08-25), not the 0.31.2 this started on (2026-04-22).
   *
   * 0.32.0, 0.32.1 and 0.32.2 carry a run of fixes and speedups for the
   * newest accelerator path -- a fused full-attention path for head_dim 256,
   * a raised qmv batch limit for large matrices, quantised-MOE matmul work,
   * and kernel bug fixes including an int16 overflow. Pinning to April's
   * release would have left the newer machine running code written before its
   * hardware was supported, and reported the shortfall as hardware.
   *
   * mlx-lm 0.31.3 is still the newest on PyPI, and asks for mlx>=0.31.2, so
   * the two resolve together with no conflict.
   */
  llm: {
    dir: "llm",
    packages: ["mlx==0.32.2", "mlx-lm==0.31.3"],
    python: "3.12",
    why: "mlx 0.32.x adds and fixes the newest chips' accelerator path; mlx-lm 0.31.3 is current and wants mlx>=0.31.2",
  },

  /**
   * mflux pulls its own mlx, which is how the image environment ends up on a
   * different one from the language models. Different workload, different
   * stack; every run records both versions so the two are never confused.
   */
  image: {
    dir: "image",
    packages: ["mflux==0.19.2"],
    python: "3.12",
    why: "mflux 0.19.2 is the release the image commands were read against",
  },

  /**
   * Nothing to install: the video port is a git checkout pinned to a commit,
   * and it brings its own environment through `uv sync`.
   */
  video: {
    dir: "video",
    packages: [],
    python: "3.12",
    why: "the LTX port is pinned by commit and syncs its own dependencies",
  },
};
