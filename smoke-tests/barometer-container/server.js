const express = require("express");
const fs      = require("fs");
const path    = require("path");
const { DatabaseSync } = require("node:sqlite");

const app  = express();
const PORT = process.env.PORT || 8080;

const DB_PATH = process.env.DB_PATH || path.join(process.env.DATA_DIR || ".", "barometer.db");

app.use(express.text({ type: "*/*" }));

let db;

async function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)");
}

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  const jsx = fs.readFileSync(
    path.join(__dirname, "sprint-confidence-barometer.jsx"), "utf8"
  );

  const transformed = jsx
    .replace(
      `import { useState, useEffect } from "react";`,
      `const { useState, useEffect } = React;`
    )
    .replace(`const API_URL = "REPLACE_WITH_API_URL";\n\n`, "")
    .replace(/`\$\{API_URL\}\/api\/state`/g, `"/api/state"`)
    .replace("export default function SprintBarometer", "function SprintBarometer");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sprint Confidence Barometer</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body style="margin:0;padding:0;background:#050d1a">
  <div id="root"></div>
  <script type="text/babel">
${transformed}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(SprintBarometer));
  </script>
</body>
</html>`);
});

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/state", (_req, res) => {
  try {
    const row = db.prepare("SELECT value FROM state WHERE key = ?").get("barometer-state");
    res.json({ value: row?.value ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read state" });
  }
});

app.post("/api/state", (req, res) => {
  try {
    db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)").run("barometer-state", req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save state" });
  }
});

app.delete("/api/state", (req, res) => {
  try {
    db.prepare("DELETE FROM state WHERE key = ?").run("barometer-state");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete state" });
  }
});

init()
  .then(() => app.listen(PORT, () => console.log(`Barometer on port ${PORT}`)))
  .catch(err => { console.error("Startup failed:", err); process.exit(1); });
