FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY requirements.txt ./
COPY desktop/development-caption-requirements.txt ./caption-requirements.txt
RUN python3 -m venv /opt/coconut-python \
    && /opt/coconut-python/bin/python -m pip install --no-cache-dir --only-binary=:all: -r requirements.txt \
    && /opt/coconut-python/bin/python -m pip install --no-cache-dir --only-binary=:all: --no-deps --require-hashes -r caption-requirements.txt
COPY server ./server
COPY desktop ./desktop
COPY reader ./reader
COPY shared ./shared
COPY scripts ./scripts
COPY *.py ./
RUN mkdir /data /models && chown node:node /data /models && chmod 700 /data
USER node
ENV COCONUT_HOST=0.0.0.0 COCONUT_PORT=8080 COCONUT_DATA_DIRECTORY=/data \
    COCONUT_ASR_PYTHON=/opt/coconut-python/bin/python COCONUT_MODEL_DIRECTORY=/models \
    COCONUT_CAPTION_PYTHON=/opt/coconut-python/bin/python
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.COCONUT_PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--env-file-if-exists=.env", "server/main.mjs"]
