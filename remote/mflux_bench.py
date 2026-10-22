"""
Time image generation with the model already loaded.

Why this exists at all, since the rest of this repo is TypeScript and the
default is no Python: the honest number for a picture is the seconds it takes
to make one on a model that is already in memory. mflux's command line loads
the model and generates in a single process, prints no per-image timing, and
writes every image of a multi-seed run to one filename, so there is no way to
read a generation time out of it that does not have a model load folded in.

This is the smallest thing that separates them. It uses mflux's OWN argument
parser, so every default it does not name -- the step count for each model, the
scheduler, the decode options -- comes from mflux at the pinned version rather
than from a guess here. It loads once, times each generation on a monotonic
clock, and prints one JSON line per event.

    python mflux_bench.py --kind z-image-turbo --count 5 \
        --model ~/bench-models/Z-Image-Turbo --prompt "..." --seed 42 \
        --width 1024 --height 1024 --output /tmp/out/img_{i}.png

Output, one JSON object per line on stdout:

    {"event": "versions", "mflux": "0.19.2", "mlx": "0.31.2"}
    {"event": "loaded", "seconds": 12.84}
    {"event": "image", "index": 0, "warmup": true,  "seconds": 3.41, "path": "...", "sha256": "..."}
    {"event": "image", "index": 1, "warmup": false, "seconds": 3.22, "path": "...", "sha256": "..."}
    {"event": "done", "peak_memory_gb": 41.2}

Anything unexpected becomes {"event": "error", "message": ...} and a non-zero
exit, so the caller can fail one cell and carry on with the rest of the grid.
"""

import argparse
import hashlib
import json
import os
import sys
import time

# Which mflux CLI module drives each kind. Borrowing its build_parser() is the
# whole trick: the defaults stay mflux's, not ours.
KINDS = {
    "flux2-klein": "mflux.models.flux2.cli.flux2_generate",
    "z-image-turbo": "mflux.models.z_image.cli.z_image_turbo_generate",
}


def emit(**payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def sha256_of_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checksum(path):
    """
    A checksum of the PICTURE, not of the file.

    mflux embeds metadata in the PNG -- an iTXt and an eXIf chunk that carry,
    among other things, how long the generation took. Two runs of the same seed
    therefore produce byte-different files whose pixels are identical, and
    hashing the file says the machine drew two different pictures when it drew
    the same one twice. Measured: 0 of 1,048,576 pixels differed between two
    such files.

    So the pixels are hashed. If the image cannot be decoded the file hash is
    used instead and the event says which, because a checksum whose meaning is
    ambiguous is worse than no checksum.
    """
    try:
        from PIL import Image

        with Image.open(path) as image:
            return hashlib.sha256(image.convert("RGB").tobytes()).hexdigest(), "pixels"
    except Exception:
        return sha256_of_file(path), "file"


def versions():
    out = {"event": "versions", "mflux": None, "mlx": None}
    try:
        from importlib.metadata import version

        out["mflux"] = version("mflux")
        out["mlx"] = version("mlx")
    except Exception:
        pass
    return out


def peak_memory_gb():
    try:
        import mlx.core as mx

        return round(mx.get_peak_memory() / (1024**3), 3)
    except Exception:
        return None


def build_args(kind, cli, options):
    """
    mflux's own parser, given the same flags its command line would take.

    Its CommandLineParser overrides `parse_args(self)` with no argv parameter
    and reads sys.argv directly, so the flags go THERE rather than being passed
    in. Found the hard way: passing them as an argument raises
    "parse_args() takes 1 positional argument but 2 were given".
    """
    argv = [
        "--model", options.model,
        "--prompt", options.prompt,
        "--seed", str(options.seed),
        "--width", str(options.width),
        "--height", str(options.height),
        "--output", options.output,
    ]
    if options.steps is not None:
        argv += ["--steps", str(options.steps)]
    if options.quantize is not None:
        argv += ["--quantize", str(options.quantize)]
    if options.base_model:
        argv += ["--base-model", options.base_model]

    saved = sys.argv
    try:
        sys.argv = ["mflux-bench", *argv]
        return cli.build_parser().parse_args()
    finally:
        sys.argv = saved


def make_model(kind, cli, args):
    """Constructed exactly as that CLI constructs it, and no other way."""
    from mflux.cli.parser.parsers import lora_init_kwargs_from_args
    from mflux.models.common.resolution.config_resolution import ConfigResolution

    if kind == "z-image-turbo":
        from mflux.models.z_image.variants.z_image import ZImage

        config = ConfigResolution.resolve_restricted(args.model, "z-image-turbo", model_path=args.model_path)
        return ZImage(
            model_config=config,
            quantize=args.quantize,
            model_path=args.model_path,
            **lora_init_kwargs_from_args(args),
        )

    from mflux.models.flux2.variants import Flux2Klein

    config = ConfigResolution.resolve_restricted(
        args.model,
        cli.DEFAULT_MODEL,
        model_path=args.model_path,
        extra_keys=cli.FAMILY_MODELS,
        base_model=args.base_model,
    )
    if args.guidance is None:
        args.guidance = 1.0
    return Flux2Klein(
        model_config=config,
        quantize=args.quantize,
        model_path=args.model_path,
        **lora_init_kwargs_from_args(args),
    )


def generate_once(kind, model, args, width, height):
    common = dict(
        seed=args.seed[0] if isinstance(args.seed, list) else args.seed,
        prompt=args.prompt,
        width=width,
        height=height,
        guidance=args.guidance,
        image_path=args.image_path,
        num_inference_steps=args.steps,
        image_strength=args.image_strength,
        pid_decode=args.pid_decode,
        pid_degrade_sigma=args.pid_degrade_sigma,
    )
    if kind == "z-image-turbo":
        return model.generate_image(scheduler=args.scheduler, negative_prompt=args.negative_prompt, **common)
    return model.generate_image(scheduler="flow_match_euler_discrete", **common)


def main():
    parser = argparse.ArgumentParser(description="Time mflux image generation with the model already loaded.")
    parser.add_argument("--kind", required=True, choices=sorted(KINDS))
    parser.add_argument("--model", required=True, help="Built-in name, HF repo id, or a local path.")
    parser.add_argument("--base-model", default=None)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--steps", type=int, default=None, help="Omit to use mflux's default for this model.")
    parser.add_argument("--quantize", type=int, default=None)
    parser.add_argument("--count", type=int, required=True, help="Measured images, after the warm-up.")
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--output", required=True, help="Path template holding {i}.")
    options = parser.parse_args()

    emit(**versions())

    import importlib

    cli = importlib.import_module(KINDS[options.kind])
    args = build_args(options.kind, cli, options)

    from mflux.utils.dimension_resolver import DimensionResolver

    width, height = DimensionResolver.resolve(width=args.width, height=args.height, reference_image_path=None)

    # --- LOAD. Timed, reported, and never added to any generation time.
    started = time.monotonic()
    model = make_model(options.kind, cli, args)
    emit(event="loaded", seconds=round(time.monotonic() - started, 4))

    os.makedirs(os.path.dirname(options.output.format(i=0)) or ".", exist_ok=True)

    total = options.warmup + options.count
    for index in range(total):
        warmup = index < options.warmup
        path = options.output.format(i=index)
        at = time.monotonic()
        image = generate_once(options.kind, model, args, width, height)
        seconds = round(time.monotonic() - at, 4)
        image.save(path=path, export_json_metadata=False)
        digest, digest_of = checksum(path)
        emit(
            event="image",
            index=index,
            warmup=warmup,
            seconds=seconds,
            path=path,
            sha256=digest,
            checksum_of=digest_of,
        )

    emit(event="done", peak_memory_gb=peak_memory_gb())


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - one cell failing must not be a traceback the caller cannot read
        emit(event="error", message=f"{type(exc).__name__}: {exc}")
        sys.exit(1)
