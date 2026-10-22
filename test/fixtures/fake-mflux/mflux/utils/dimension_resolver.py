"""Stand-in for mflux.utils.dimension_resolver."""


class DimensionResolver:
    @staticmethod
    def resolve(width, height, reference_image_path=None):  # noqa: ARG004
        return width, height
