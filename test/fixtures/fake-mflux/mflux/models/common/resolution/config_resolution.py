"""Stand-in for mflux.models.common.resolution.config_resolution."""


class ModelConfig:
    def __init__(self, model_name):
        self.model_name = model_name


class ConfigResolution:
    @staticmethod
    def resolve_restricted(model, default, model_path=None, extra_keys=(), base_model=None):  # noqa: ARG004
        return ModelConfig(default)

    @staticmethod
    def infer_family_member(model_path, default, family):  # noqa: ARG004
        return None
