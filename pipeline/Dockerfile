# Radweg Tycoon – Kartenpipeline
#   docker build -t radwegtycoon-pipeline pipeline/
#   docker run --rm -v /pfad/zu/daten:/data radwegtycoon-pipeline alles regionen/lippe.yaml
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY rtc ./rtc
COPY regionen ./regionen
COPY tests ./tests

ENV PYTHONUNBUFFERED=1
VOLUME /data
ENTRYPOINT ["python", "-m", "rtc"]
CMD ["--help"]
