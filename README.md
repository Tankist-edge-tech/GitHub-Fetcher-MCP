# github-fetcher
Many AI agents including Claude fail to fetch github repositories including files.
**This MCP solves this.**

**Give AI agents eyes on GitHub.** A self-documenting HTTP API + MCP server, hosted free on [Val Town](https://www.val.town), that turns any public GitHub repository into an AI-readable file tree and source fetcher. Works as a plain HTTP API from any agent, or as **native tools inside Claude** via a custom connector.

```
Claude / any AI agent
   │  (MCP over HTTP, native tools)          (plain HTTP, ?params)
   ▼                                              ▼
┌─────────────────┐    internal fetch    ┌──────────────────┐      ┌───────────────┐
│  mcp.ts         │ ───────────────────► │  fetcher.ts      │ ───► │  GitHub API   │
│  MCP wrapper    │                      │  HTTP API        │      │  (+ your PAT) │
└─────────────────┘                      └──────────────────┘      └───────────────┘
```

## What it does

| Mode | Call | Returns |
|---|---|---|
| File tree | `?owner=USER&repo=REPO` (or `?url=https://github.com/USER/REPO`) | Every file path + byte size + raw URL, paginated |
| Single file | `?owner=USER&repo=REPO&file=src/index.ts` | Full file content |
| README | `?owner=USER&repo=REPO&readme` | README content, whatever it's named |
| Quota status | `?status` | Remaining GitHub API quota + reset time |

Highlights:

- **Self-documenting** — call it with `?help` and it teaches the agent everything else. No external docs needed.
- **Default-branch aware** — resolves `main`, `master`, `canary`, whatever, instead of guessing.
- **Pagination** — `limit` / `offset`, with the next-page offset printed right in the output so agents can auto-paginate. Handles 30,000+ file monorepos.
- **Path filtering** — `&path=src/` scopes the tree to a subfolder (recursive).
- **JSON mode** — `&format=json` for structured output; errors become `{"error": "..."}`.
- **Binary guard** — refuses to return image/zip bytes as text (HTTP 415) instead of dumping garbage into a context window.
- **Rate-limit friendly** — reads an optional `GITHUB_TOKEN` env var (60 → 5,000 req/hour).

## Repo contents

This repo contains the two source files. They are meant to be **pasted into [Val Town](https://www.val.town)**, which hosts them for free — you don't run anything locally.

| File | What it is |
|---|---|
| `fetcher.ts` | The HTTP API val (the core). Works standalone. |
| `mcp.ts` | MCP wrapper val. Optional — only needed for native Claude tools. |

## Setup, part 1 — the fetcher API (~5 minutes)

This is the exact path that works, including the two gotchas that cost me time.

### 1. Create the val (careful: it must be an *HTTP file*)

1. Sign up at [val.town](https://www.val.town) (free) and create a new project.
2. In the project, use **"Add an HTTP file"** — or, after creating a plain file, attach an **HTTP trigger** to it via the **+ Add trigger** button.

> **Gotcha #1:** A plain `.ts` file in a Val Town project is just a script. Only files with an **HTTP trigger** get a public URL. If your endpoint returns "Val not found", this is why — I lost an hour to this. You can check anytime in the **App** tab: it lists every HTTP endpoint the project actually serves.

### 2. Paste the code and save

- Open `fetcher.ts` from this repo, copy **everything**, paste it into your HTTP file.
- **Save** (Ctrl+S).

> **Gotcha #2:** Unsaved changes don't go live. If curl shows you old behavior, you forgot to save — I did this too.

### 3. Add a GitHub token (optional but recommended)

Anonymous GitHub API access is **60 requests/hour per IP**. A token raises it to **5,000/hour**.

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. Repository access: **Public repositories (read-only)**. Permissions: leave everything empty. That's all this tool needs — a read-only public token is harmless if abused, because that's all it can do.
3. In your Val Town project: **Env vars** → add `GITHUB_TOKEN` with the token value. Next request picks it up automatically — no redeploy.

Verify: open `https://YOUR-VAL-URL?status` → it should say `GITHUB_TOKEN active` with 5000 remaining.

### 4. Test it

```bash
curl "https://YOUR-VAL-URL?help"                                  # usage doc
curl "https://YOUR-VAL-URL?owner=facebookresearch&repo=tribev2"   # file tree
curl "https://YOUR-VAL-URL?owner=facebookresearch&repo=tribev2&file=README.md"
curl "https://YOUR-VAL-URL?owner=facebookresearch&repo=tribev2&readme"
curl "https://YOUR-VAL-URL?owner=facebookresearch&repo=tribev2&format=json&limit=5"
curl "https://YOUR-VAL-URL?status"
```

That's it — any AI agent with web access can now use your API. Give it the URL plus this one-liner:

> *You can fetch GitHub repo structures and file contents via this API. Call it with `?help` first — it is self-documenting.*

## Setup, part 2 — native Claude tools via MCP (~10 minutes)

Optional. This turns the API into three named tools inside Claude (`list_repo_files`, `fetch_repo_file`, `fetch_repo_readme`) using Claude's **custom connectors** (remote MCP servers).

### 1. Add a second HTTP file with the MCP wrapper

1. In the same Val Town project, **add another HTTP file** (same rule as before: it needs an HTTP trigger to get a URL).
2. Paste `mcp.ts` from this repo.
3. Point it at your fetcher: set a `FETCHER_URL` env var to your fetcher's URL, or edit the fallback constant at the top of `mcp.ts`.
4. Save. Copy the new file's HTTP URL from the **App** tab (each HTTP file gets its own URL).
5. Sanity check: open that URL in a browser → it must say exactly **`MCP endpoint: use POST`**. If you see the help document, you copied the fetcher's URL.

### 2. Register it in Claude

Claude → **+** → **Add connector** → **Add custom connector**:

- **URL:** your mcp.ts URL
- **Authentication:** *No sign-in* (the server has no auth; Claude auto-detects this)
- **Transport:** *Streamable HTTP* (default)

### 3. Test

Ask Claude:

> *List the files in facebookresearch/tribev2, then show me the first 50 lines of tribev2/main.py.*

You should see Claude invoke `list_repo_files`, then chain `fetch_repo_file` — no further instructions needed. The tool descriptions do the teaching.

## API reference (short version)

Full reference is served live at `?help` — that copy is always current.

| Parameter | Meaning |
|---|---|
| `owner`, `repo` | Repository. Or pass `url=https://github.com/USER/REPO` |
| `file=PATH` | Fetch one file (case-sensitive, relative to repo root) |
| `readme` | Fetch the README (any filename/format) |
| `path=PREFIX` | Tree filter: prefix match from repo root, includes subfolders |
| `format=json` | JSON output for every mode, including errors |
| `limit` / `offset` | Pagination (default 500/page, max 5000) |
| `status` | GitHub API quota remaining + reset time |
| `help` | The self-documenting usage guide |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| HTML page: "Val not found" | File has no HTTP trigger, or URL doesn't match | Add/verify the HTTP trigger; copy the URL from the **App** tab |
| Old behavior after edits | Forgot to Save | Ctrl+S, retest |
| `403` from GitHub | Rate limit (60/h anonymous) | Set `GITHUB_TOKEN` env var |
| Cloudflare "Attention Required" page | Some datacenter IPs get challenged by Val Town's edge | Nothing to fix on your side; affects a minority of clients. Residential IPs and major AI platforms pass. |
| `File appears to be binary` (415) | Requested a non-text file | By design — protects the context window |
| MCP tools missing in Claude | Connector points at the fetcher URL instead of the mcp.ts URL | The mcp.ts URL must answer `MCP endpoint: use POST` on GET |

## Notes on sharing and limits

- **No sign-in means open access.** Anyone who finds your URLs can use the tools — which spends *your* GitHub quota. Fine for personal use; if you need to gate it, add a simple key check in `mcp.ts` (compare a header against an env var).
- **Token expiry:** fine-grained tokens can expire if not set to don't expire. When yours does, `?status` flips to "anonymous" — generate a new one and update the env var.
- **Cost:** Val Town free tier is enough for personal use; GitHub API is free at 5,000 req/h.

## License

[MIT](LICENSE) — do whatever you want, attribution appreciated.
