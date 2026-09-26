# Build context is this backend/ directory (this repo has no shared
# libs/ to install from the root, unlike the main platform).
FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Big numpy arrays (volumes, masks, scipy's work arrays) straight from mmap
# and back to the OS when freed. glibc's default raises this threshold after
# the first large free, so later ones land in the heap and stay: the RSS
# crept from ~550 MB to past the 1.5 GB limit over a few series while the
# live data stayed at ~350 MB.
ENV MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
