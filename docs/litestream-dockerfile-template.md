# Litestream Dockerfile Template

Copy these files into your project to get SQLite persistence backed by Azure Blob Storage.
The deploy agent injects the required env vars (`DATA_DIR`, `AZURE_STORAGE_*`) automatically when you deploy with `persistent_storage: true`.

## File: Dockerfile

```dockerfile
FROM node:22   # change to your language/runtime

# Install litestream (SQLite → Azure Blob replication)
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && rm /tmp/litestream.tar.gz

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

COPY litestream.yml /etc/litestream.yml
COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 8080
CMD ["./start.sh"]
```

## File: litestream.yml

```yaml
dbs:
  - path: ${DB_PATH}
    replicas:
      - type: abs
        account-name: ${AZURE_STORAGE_ACCOUNT_NAME}
        account-key: ${AZURE_STORAGE_ACCOUNT_KEY}
        bucket: ${AZURE_STORAGE_CONTAINER}
        path: db.sqlite
```

## File: start.sh

```sh
#!/bin/sh
set -e
litestream restore -if-replica-exists -config /etc/litestream.yml "${DB_PATH}"
exec litestream replicate -exec "node server.js" -config /etc/litestream.yml
```

Replace `node server.js` with your app's start command.

## App code

Use `DATA_DIR` as the base path for your database:

```js
// Node.js example
const DB_PATH = process.env.DB_PATH
  || require("path").join(process.env.DATA_DIR || ".", "app.db");
```

```python
# Python example
import os, pathlib
DB_PATH = os.environ.get("DB_PATH") or str(pathlib.Path(os.environ.get("DATA_DIR", ".")) / "app.db")
```

## Important: maxReplicas is enforced to 1

When `persistent_storage: true`, the deploy agent sets `maxReplicas: 1`.
SQLite does not support concurrent writers — do not override this.
