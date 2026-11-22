FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Europe/Berlin \
    APP_TIMEZONE=Europe/Berlin \
    TIMESAVE_CLOUD_MODE=1 \
    TIMESAVE_FREE_PREVIEW=1 \
    TIMESAVE_DATA_DIR=/var/data/timesave

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-dejavu-core \
        ca-certificates \
        tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/data/timesave /tmp/timesave

WORKDIR /opt/timesave

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"10000\")}/api/health', timeout=4)" || exit 1

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1 --proxy-headers --forwarded-allow-ips '*' --timeout-graceful-shutdown 30"]
