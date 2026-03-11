FROM node:22

# Install litestream
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && rm /tmp/litestream.tar.gz

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js sprint-confidence-barometer.jsx ./
COPY litestream.yml /etc/litestream.yml
COPY start.sh ./
RUN chmod +x start.sh

ENV DATA_DIR=/data
ENV DB_PATH=/data/barometer.db

EXPOSE 8080
CMD ["./start.sh"]
