FROM python:3.12-slim

# eyecite plus its hyperscan dependency. hyperscan is the high-performance
# regex matcher eyecite uses; it pulls in apt deps. lxml is a transitive
# need on some platforms.
RUN pip install --no-cache-dir eyecite

WORKDIR /work

COPY detect_citations.py /work/detect_citations.py

ENTRYPOINT ["python3", "/work/detect_citations.py"]
