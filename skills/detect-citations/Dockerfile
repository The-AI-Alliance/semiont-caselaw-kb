FROM python:3.12-slim

# eyecite's `fast-diff-match-patch` dependency builds a native wheel and
# requires a C++ toolchain. Install build tools, build the wheel, then
# strip the toolchain to keep the runtime image lean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && pip install --no-cache-dir eyecite \
  && apt-get purge -y --auto-remove build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work

COPY detect_citations.py /work/detect_citations.py

ENTRYPOINT ["python3", "/work/detect_citations.py"]
