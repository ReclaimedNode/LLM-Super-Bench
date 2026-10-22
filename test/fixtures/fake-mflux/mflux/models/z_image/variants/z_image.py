"""Stand-in for mflux.models.z_image.variants.z_image."""
import time

import json as _json, os as _os


def _record(kind, event, payload):
    path = _os.environ.get("MFLUX_STUB_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(_json.dumps({"kind": kind, "event": event, **payload}, default=str) + "\n")

from mflux.utils.generated_image import GeneratedImage


class ZImage:
    """Records how it was constructed so a test can assert the shim did it right."""

    def __init__(self, model_config=None, quantize=None, model_path=None, **kwargs):
        self.model_config = model_config
        self.quantize = quantize
        self.model_path = model_path
        self.kwargs = kwargs
        # A load that takes a measurable moment, so "loaded" cannot be zero and
        # cannot be confused with a generation.
        time.sleep(0.08)
        self.calls = []
        _record("z-image-turbo", "construct", {"quantize": quantize, "model_path": model_path, "model_name": getattr(model_config, "model_name", None)})

    def generate_image(self, **kwargs):
        self.calls.append(kwargs)
        _record("z-image-turbo", "generate", dict(kwargs))
        time.sleep(0.03)
        return GeneratedImage(kwargs)
