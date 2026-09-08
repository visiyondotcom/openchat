# The image that actually runs admin-submitted code. Kept as small and
# dependency-free as reasonably possible: nothing in here should make an
# escape or a resource-exhaustion attempt easier than plain CPython would.
FROM python:3.12-slim

# Nothing else gets installed here on purpose — admin filters that need a
# package should vendor it inline or call an allowed HTTP tool via the
# normal tools system instead, since this container has no network.
WORKDIR /sandbox
COPY run_filter.py run_code.py .

# Runs as root at build time only; sandbox-runner overrides to uid 65534
# ("nobody") at container-run time via `user=`, so this USER line is a
# defense-in-depth fallback in case that override is ever omitted.
USER 65534:65534

ENTRYPOINT ["python", "/sandbox/run_filter.py"]
# Default entrypoint runs run_filter.py (Filter/Pipe/Action class contract).
# sandbox-runner's /run-code endpoint overrides this per-container via
# docker-py's `entrypoint=` to ["python", "/sandbox/run_code.py"] instead —
# same image, same isolation, different script for arbitrary top-level
# scripts (the code-block "Run" button and the run_python tool).
