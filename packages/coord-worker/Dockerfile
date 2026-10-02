# NexTwin BIM coordination worker (IDS validation with IfcTester).
# Base image pinned by digest (A03); dependencies locked with hashes in uv.lock.
FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016 AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.30 /uv /bin/uv

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app

COPY ./packages/coord-worker/pyproject.toml ./packages/coord-worker/uv.lock /src/
WORKDIR /src
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016

ENV PATH=/app/bin:$PATH \
    PYTHONUNBUFFERED=1

# Don't run as root
RUN groupadd -r app && useradd -r -d /app -g app -N app

COPY --from=build --chown=app:app /app /app
COPY --chown=app:app ./packages/coord-worker/coord_worker /app/coord_worker

USER app
WORKDIR /app
STOPSIGNAL SIGTERM
CMD ["python", "-m", "coord_worker.main"]
