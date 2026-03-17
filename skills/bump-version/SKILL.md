---
name: bump-version
description: >
  This skill should be used when the user asks to "bump version", "release a new version",
  "increment version", "update version", "prepare release", "bump patch/minor/major",
  or mentions version numbers in the context of releasing the plugin.
  Ensures all 3 version locations stay in sync.
---

# Bump Version

Bump the plugin version across all required files in a single operation. This plugin stores its version in **3 places** that must stay in sync — missing any one causes marketplace confusion or stale listings.

## Version Locations

| # | File | JSON path |
|---|---|---|
| 1 | `package.json` | `$.version` |
| 2 | `.claude-plugin/plugin.json` | `$.version` |
| 3 | `.claude-plugin/marketplace.json` | `$.plugins[0].version` |

## Procedure

### 1. Read current version

Read all 3 files and extract the current version from each. Verify they match. If they don't, warn the user and align them before proceeding.

### 2. Determine bump type

If the user specified a version or bump type, use it. Otherwise ask:

| Type | When to use | Example |
|---|---|---|
| `patch` (default) | Bug fixes, small tweaks | 0.4.1 → 0.4.2 |
| `minor` | New features, new tools | 0.4.1 → 0.5.0 |
| `major` | Breaking changes | 0.4.1 → 1.0.0 |

The user may also provide an explicit version string (e.g. "bump to 1.0.0").

### 3. Apply the bump

Edit all 3 files, replacing the old version with the new one. Use the Edit tool for precision — do not rewrite entire files.

### 4. Verify

After editing, read back all 3 files and confirm the new version appears in each. Report the result:

```
Version bumped: 0.4.1 → 0.4.2

  package.json                    ✓
  .claude-plugin/plugin.json      ✓
  .claude-plugin/marketplace.json ✓
```

### 5. Remind about next steps

After bumping, remind the user:
- Commit the version bump (offer to do it)
- The MCP server is long-running — Claude Code must be restarted for the new version to take effect
