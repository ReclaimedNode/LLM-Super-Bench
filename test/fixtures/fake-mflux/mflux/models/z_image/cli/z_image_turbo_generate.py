"""Stand-in for the z-image-turbo CLI entry point."""
from mflux.cli.parser.parsers import CommandLineParser

DEFAULT_MODEL = "z-image-turbo"
# mflux's own tests pin 9 for this model.
DEFAULT_STEPS = 9


def build_parser():
    return CommandLineParser(default_model=DEFAULT_MODEL, default_steps=DEFAULT_STEPS)
