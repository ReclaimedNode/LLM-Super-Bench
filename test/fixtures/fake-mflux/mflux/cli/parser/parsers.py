"""Stand-in for mflux.cli.parser.parsers."""
import argparse


def lora_init_kwargs_from_args(args):  # noqa: ARG001
    return {}


class CommandLineParser(argparse.ArgumentParser):
    """Carries the same flags and the same per-model --steps defaulting."""

    def __init__(self, default_model=None, default_steps=25, **kwargs):
        super().__init__(**kwargs)
        self._default_model = default_model
        self._default_steps = default_steps
        self.add_argument("--model", "-m", default=default_model)
        self.add_argument("--base-model", default=None)
        self.add_argument("--prompt", default=None)
        self.add_argument("--seed", type=int, nargs="+", default=[42])
        self.add_argument("--width", type=int, default=1024)
        self.add_argument("--height", type=int, default=1024)
        self.add_argument("--steps", type=int, default=None)
        self.add_argument("--quantize", "-q", type=int, default=None)
        self.add_argument("--output", default="image.png")
        self.add_argument("--guidance", type=float, default=None)
        self.add_argument("--image-path", default=None)
        self.add_argument("--image-strength", type=float, default=None)
        self.add_argument("--scheduler", default="flow_match_euler_discrete")
        self.add_argument("--negative-prompt", default=None)
        self.add_argument("--pid-decode", action="store_true")
        self.add_argument("--pid-degrade-sigma", type=float, default=None)

    def parse_args(self):  # noqa: A003 - mirrors mflux, which takes no argv
        # The real mflux overrides argparse's signature and reads sys.argv
        # itself. Copying that here is the point: the stand-in that allowed an
        # argv argument let a shim through that the real parser rejected with
        # "parse_args() takes 1 positional argument but 2 were given".
        parsed = super().parse_args()
        # mflux keys the --steps default off the model, and computes model_path
        # for anything that is not a built-in name.
        if parsed.steps is None:
            parsed.steps = self._default_steps
        parsed.model_path = None if parsed.model == self._default_model else parsed.model
        return parsed
