# Hugging Face Docker Space: builds the Vite app, then serves it + /api via FastAPI.
# https://huggingface.co/docs/hub/spaces-sdks-docker

FROM node:20-bookworm-slim AS webgl-build
WORKDIR /src
COPY webgl/package.json webgl/package-lock.json ./
RUN npm ci
COPY webgl/ ./
RUN npm run build

FROM python:3.11-slim-bookworm
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY index.html .
COPY app.html .
COPY favicon.svg .
COPY icons.svg .
COPY style.css .
COPY assets/ ./assets/
COPY --from=webgl-build /src/dist ./webgl/dist

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
