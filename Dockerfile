# Stage 1: build the frontend
FROM node:22-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: runtime
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libimage-exiftool-perl \
    file \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend /fe/dist ./static

ENV MEDIALIB_DATA=/data
VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
