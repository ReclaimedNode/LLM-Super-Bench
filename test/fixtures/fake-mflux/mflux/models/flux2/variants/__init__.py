"""Stand-in for mflux.models.flux2.variants."""
import time

import json as _json, os as _os


def _record(kind, event, payload):
    path = _os.environ.get("MFLUX_STUB_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(_json.dumps({"kind": kind, "event": event, **payload}, default=str) + "\n")

from mflux.utils.generated_image import GeneratedImage


class Flux2Klein:
    def __init__(self, model_config=None, quantize=None, model_path=None, **kwargs):
        self.model_config = model_config
        self.quantize = quantize
        self.model_path = model_path
        self.kwargs = kwargs
        time.sleep(0.08)
        self.calls = []
        _record("flux2-klein", "construct", {"quantize": quantize, "model_path": model_path, "model_name": getattr(model_config, "model_name", None)})

    def generate_image(self, **kwargs):
        self.calls.append(kwargs)
        _record("flux2-klein", "generate", dict(kwargs))
        time.sleep(0.03)
        return GeneratedImage(kwargs)
