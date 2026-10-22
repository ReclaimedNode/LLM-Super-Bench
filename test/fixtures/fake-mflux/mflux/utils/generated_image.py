"""Stand-in for whatever mflux's generate_image returns."""
import json


class GeneratedImage:
    def __init__(self, params):
        self.params = params

    def save(self, path, export_json_metadata=False):  # noqa: ARG002
        # The bytes vary with the seed and prompt, so a checksum means
        # something: two runs with the same seed give the same file.
        payload = json.dumps(
            {k: v for k, v in sorted(self.params.items()) if isinstance(v, (str, int, float, type(None)))},
            sort_keys=True,
        )
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(payload)
