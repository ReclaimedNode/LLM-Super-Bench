# Stand-in for mlx.core. The shim's peak_memory_gb() calls get_peak_memory(),
# which real MLX reports in bytes. A fixed value lets the test check the shim
# reads it and converts it, on any machine, with or without real MLX installed.

_PEAK_BYTES = 12 * 1024**3


def get_peak_memory():
    return _PEAK_BYTES
