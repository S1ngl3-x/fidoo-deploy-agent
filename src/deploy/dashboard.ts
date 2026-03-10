import type { AppEntry } from "./registry.js";

export function generateDashboardHtml(apps: AppEntry[]): string {
  const escapedData = JSON.stringify(apps).replace(/<\//g, "<\\/");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'">
  <title>Vibe Coded Apps</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=DM+Sans:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #FAFAF8;
      --surface: #FFFFFF;
      --border: #E8E6E1;
      --border-hover: #D0CEC8;
      --text-primary: #1A1A18;
      --text-secondary: #6B6965;
      --text-tertiary: #9C9890;
      --accent: #E85D26;
      --accent-soft: #FFF0EB;
      --font-display: 'Space Grotesk', system-ui, sans-serif;
      --font-body: 'DM Sans', system-ui, sans-serif;
    }

    *, *::before, *::after {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--text-primary);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    .page {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 2rem 4rem;
    }

    /* ── Header ── */
    .header {
      padding: 3.5rem 0 3rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 2.5rem;
    }

    .header-label {
      font-family: var(--font-display);
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .header-label::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .header h1 {
      font-family: var(--font-display);
      font-size: 2.75rem;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.03em;
      color: var(--text-primary);
      margin-bottom: 0.75rem;
    }

    .header-sub {
      font-size: 1.1rem;
      color: var(--text-secondary);
      line-height: 1.5;
      max-width: 520px;
    }

    .header-meta {
      display: flex;
      align-items: center;
      gap: 1.5rem;
      margin-top: 1.5rem;
      font-size: 0.85rem;
      color: var(--text-tertiary);
      font-family: var(--font-display);
      font-weight: 500;
    }

    .meta-count strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    /* ── Grid ── */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.25rem;
    }

    /* ── Card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
      cursor: pointer;
      position: relative;
      overflow: hidden;

      opacity: 0;
      animation: cardIn 0.4s ease forwards;
    }

    .card:hover {
      border-color: var(--border-hover);
      box-shadow: 0 4px 24px rgba(0,0,0,0.06);
      transform: translateY(-2px);
    }

    .card:hover .card-arrow {
      opacity: 1;
      transform: translate(0, 0);
    }

    @keyframes cardIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
    }

    .card-name {
      font-family: var(--font-display);
      font-size: 1.15rem;
      font-weight: 600;
      letter-spacing: -0.01em;
      line-height: 1.3;
    }

    .card-arrow {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--accent-soft);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transform: translate(-4px, 4px);
      transition: opacity 0.2s, transform 0.2s;
      font-size: 0.85rem;
      color: var(--accent);
    }

    .card-desc {
      font-size: 0.9rem;
      color: var(--text-secondary);
      line-height: 1.55;
      flex: 1;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .card-desc-empty {
      color: var(--text-tertiary);
      font-style: italic;
    }

    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
      font-size: 0.8rem;
      color: var(--text-tertiary);
    }

    .card-author {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-weight: 500;
      min-width: 0;
    }

    .card-avatar {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent-soft) 0%, #fce4db 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-display);
      font-size: 0.6rem;
      font-weight: 700;
      color: var(--accent);
      flex-shrink: 0;
    }

    .card-author-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .card-time {
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ── Empty State ── */
    .empty {
      grid-column: 1 / -1;
      text-align: center;
      padding: 4rem 2rem;
      border: 2px dashed var(--border);
      border-radius: 16px;
    }

    .empty-icon {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      opacity: 0.6;
    }

    .empty h2 {
      font-family: var(--font-display);
      font-size: 1.3rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .empty p {
      color: var(--text-tertiary);
      font-size: 0.95rem;
    }

    @media (max-width: 720px) {
      .page { padding: 0 1.25rem 3rem; }
      .header { padding: 2.5rem 0 2rem; }
      .header h1 { font-size: 2rem; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="header">
      <div class="header-label">Live on Fidoo Cloud</div>
      <h1>Vibe Coded Apps</h1>
      <p class="header-sub">Apps built with AI, deployed in seconds. Pick one and dive in.</p>
      <div class="header-meta" id="meta"></div>
    </header>
    <div class="grid" id="apps"></div>
  </div>
  <script>
    var apps = ${escapedData};
    var container = document.getElementById("apps");
    var meta = document.getElementById("meta");

    function timeAgo(dateStr) {
      var now = Date.now();
      var then = new Date(dateStr).getTime();
      var diff = now - then;
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return mins + "m ago";
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + "h ago";
      var days = Math.floor(hrs / 24);
      if (days < 30) return days + "d ago";
      var months = Math.floor(days / 30);
      if (months < 12) return months + "mo ago";
      return Math.floor(months / 12) + "y ago";
    }

    function getInitials(name) {
      if (!name) return "?";
      var clean = name.split("@")[0];
      var parts = clean.split(/[._-]/);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return clean.slice(0, 2).toUpperCase();
    }

    function formatName(name) {
      if (!name) return "Unknown";
      var local = name.split("@")[0];
      return local.split(/[._-]/).map(function(w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      }).join(" ");
    }

    function el(tag, className) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      return node;
    }

    if (apps.length === 0) {
      var empty = el("div", "empty");
      var icon = el("div", "empty-icon");
      icon.textContent = "\\u{1F680}";
      var emptyTitle = el("h2");
      emptyTitle.textContent = "No apps yet";
      var emptyDesc = el("p");
      emptyDesc.textContent = "Deploy your first app to see it here.";
      empty.appendChild(icon);
      empty.appendChild(emptyTitle);
      empty.appendChild(emptyDesc);
      container.appendChild(empty);
    } else {
      var countEl = el("span", "meta-count");
      var countStrong = el("strong");
      countStrong.textContent = String(apps.length);
      countEl.appendChild(countStrong);
      countEl.appendChild(document.createTextNode("\\u00A0app" + (apps.length === 1 ? "" : "s") + " deployed"));
      meta.appendChild(countEl);

      apps.forEach(function(app, i) {
        var a = el("a", "card");
        a.href = app.url || ("/" + app.slug + "/");
        if (app.url) a.target = "_blank";
        a.style.animationDelay = (i * 0.06) + "s";

        var top = el("div", "card-top");
        var name = el("span", "card-name");
        name.textContent = app.name;
        top.appendChild(name);

        var arrow = el("div", "card-arrow");
        arrow.textContent = "\\u2197";
        top.appendChild(arrow);
        a.appendChild(top);

        var desc = el("div", app.description ? "card-desc" : "card-desc card-desc-empty");
        desc.textContent = app.description || "No description";
        a.appendChild(desc);

        var footer = el("div", "card-footer");

        if (app.deployedBy) {
          var author = el("div", "card-author");
          var avatar = el("div", "card-avatar");
          avatar.textContent = getInitials(app.deployedBy);
          author.appendChild(avatar);
          var authorName = el("span", "card-author-name");
          authorName.textContent = formatName(app.deployedBy);
          author.appendChild(authorName);
          footer.appendChild(author);
        }

        if (app.deployedAt) {
          var time = el("span", "card-time");
          time.textContent = timeAgo(app.deployedAt);
          footer.appendChild(time);
        }

        a.appendChild(footer);
        container.appendChild(a);
      });
    }
  </script>
</body>
</html>`;
}
