"""Stand-in for the flux2 CLI entry point."""
from mflux.cli.parser.parsers import CommandLineParser

DEFAULT_MODEL = "flux2-klein-4b"
FAMILY_MODELS = ("flux2-klein-9b", "flux2-klein-base-9b")
# mflux's own tests pin 4 for this model.
DEFAULT_STEPS = 4


def build_parser():
    return CommandLineParser(default_model=DEFAULT_MODEL, default_steps=DEFAULT_STEPS)
