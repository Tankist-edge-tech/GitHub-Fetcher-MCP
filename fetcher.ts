const HELP_TEXT = `GitHub Repo Fetcher - API for AI agents to explore GitHub repositories.

WORKFLOW (recommended)
  1. Get the file tree:  ?owner=USER&repo=REPO   (or ?url=GITHUB_URL)
  2. Pick relevant paths from the listing.
  3. Fetch content:      ?owner=USER&repo=REPO&file=PATH
  Tip: ?readme alone is often enough to understand a repo.

MODES
  Repo file tree : ?owner=USER&repo=REPO
                   ?url=https://github.com/USER/REPO
  Single file    : ?owner=USER&repo=REPO&file=path/to/file
  README         : ?owner=USER&repo=REPO&readme
  Quota status   : ?status

OPTIONS
  path=PREFIX   filter tree to paths starting with PREFIX; relative to repo
                root; recursive (includes subfolders); e.g. path=src/
  format=json   JSON output for all modes (errors become {"error":"..."})
  limit=N       files per page (default 500, max 5000)
  offset=N      skip the first N files. PAGINATION: when the output has a
                MORE: line (text) or has_more:true + next_offset (json),
                repeat the request with that offset to get the next page.
  help          this message

OUTPUT (tree mode)
  Text: header with branch/total count, then "path (size bytes)" with a
  "  raw:" URL per file. JSON: {repository, branch, total_files,
  github_truncated, offset, count, has_more, next_offset,
  files:[{path, size, raw_url}]}.

ERRORS
  400 invalid params | 404 repo/file not found | 403 rate limit exceeded
  (retry after quota reset) | 415 binary file content not returned.
  Messages are plain text, or {"error":...} with format=json.

NOTES
  - Public repos only. File paths are case-sensitive.
  - Raw URLs use /HEAD/ so they always resolve the default branch.
  - Huge repos may be truncated by GitHub (github_truncated: true).
  - Tree requests cost 2 GitHub API calls; quota is shared. If you get
    403, check ?status and wait for the reset time.`;

export default async function(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const wantsJson = params.get("format") === "json";

  // Unified responder: plain text by default, JSON when requested
  const reply = (text: string, json: object, status = 200) =>
    new Response(wantsJson ? JSON.stringify(json, null, 2) : text, {
      status,
      headers: {
        "Content-Type": wantsJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      },
    });

  // ── Self-documenting entry point ─────────────────────────────────────
  if (params.has("help")) return reply(HELP_TEXT, { usage: HELP_TEXT });

  const headers: Record<string, string> = {
    "User-Agent": "AI-Repo-Fetcher",
    "Accept": "application/vnd.github+json",
  };
  // Optional: set GITHUB_TOKEN in this val's env vars -> 5000 req/h instead of 60
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const api = (path: string) => `https://api.github.com${path}`;

  // ── Mode 0: GitHub API quota status ──────────────────────────────────
  // ?status
  if (params.has("status")) {
    const rlRes = await fetch("https://api.github.com/rate_limit", { headers });
    const rl = await rlRes.json();
    const core = rl.resources.core;
    const msg =
      `GitHub API quota: ${core.remaining}/${core.limit} remaining` +
      ` (${core.limit === 5000 ? "GITHUB_TOKEN active" : "anonymous — token not picked up"})` +
      `\nResets at: ${new Date(core.reset * 1000).toISOString()}`;
    return reply(msg, rl.resources.core);
  }

  const fullUrl = params.get("url");
  let owner = params.get("owner");
  let repo = params.get("repo");

  // If a full GitHub URL is provided, parse it
  if (fullUrl) {
    try {
      const parsed = new URL(fullUrl);
      if (parsed.hostname.replace(/^www\./, "") !== "github.com") {
        return reply("Only github.com URLs are supported.", { error: "Only github.com URLs are supported." }, 400);
      }
      const parts = parsed.pathname.split("/").filter(Boolean);
      owner = parts[0];
      repo = parts[1];
    } catch {
      return reply("Invalid GitHub URL provided.", { error: "Invalid GitHub URL provided." }, 400);
    }
  }

  if (!owner || !repo) {
    return reply(
      `Missing parameters!\n\n${HELP_TEXT}`,
      { error: "Missing parameters. Pass ?url=https://github.com/USER/REPO or ?owner=USER&repo=REPO.", usage: HELP_TEXT },
      400
    );
  }

  // Sanitize: strip .git suffix, validate to prevent path tricks
  repo = repo.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return reply("Invalid owner or repo name.", { error: "Invalid owner or repo name." }, 400);
  }

  // ── Mode 2: single file content ──────────────────────────────────────
  // ?owner=USER&repo=REPO&file=src/index.ts
  const file = params.get("file");
  if (file) {
    const safePath = file.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    const rawRes = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${safePath}`, { headers }
    );
    if (!rawRes.ok) {
      const msg = `File not found: ${file} (check the path and casing, or it may be a directory).`;
      return reply(msg, { error: msg }, rawRes.status === 404 ? 404 : 502);
    }
    // Guard against binary content
    const ctype = rawRes.headers.get("content-type") ?? "";
    const looksText = /^(text\/|application\/(json|javascript|xml|yaml|x-yaml|sql))/.test(ctype);
    if (!looksText) {
      const msg = `File appears to be binary (${ctype}); content was not returned.`;
      return reply(msg, { error: msg, content_type: ctype }, 415);
    }
    const content = await rawRes.text();
    return reply(content, {
      repository: `${owner}/${repo}`,
      file,
      size: content.length,
      content,
    });
  }

  // ── Mode 3: README shortcut ──────────────────────────────────────────
  // ?owner=USER&repo=REPO&readme
  if (params.has("readme")) {
    const readmeRes = await fetch(api(`/repos/${owner}/${repo}/readme`), { headers });
    if (!readmeRes.ok) {
      const s = readmeRes.status;
      const msg =
        s === 404 ? `No README found in ${owner}/${repo}.` :
        s === 403 ? `GitHub API rate limit reached. Set a GITHUB_TOKEN env var in this val to raise the limit.` :
        `GitHub API error ${s} while fetching README of ${owner}/${repo}.`;
      return reply(msg, { error: msg }, s);
    }
    const meta = await readmeRes.json();
    // API returns base64; decode as UTF-8 bytes so multibyte chars survive
    const bytes = Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
    const content = new TextDecoder().decode(bytes);
    return reply(content, {
      repository: `${owner}/${repo}`,
      file: meta.path,
      size: meta.size,
      html_url: meta.html_url,
      download_url: meta.download_url,
      content,
    });
  }

  // ── Mode 1: repo structure listing ───────────────────────────────────
  // Resolve the default branch instead of guessing main/master
  let branch = "main";
  const repoRes = await fetch(api(`/repos/${owner}/${repo}`), { headers });
  if (repoRes.ok) {
    branch = (await repoRes.json()).default_branch ?? "main";
  }

  const treeRes = await fetch(
    api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`),
    { headers }
  );

  if (!treeRes.ok) {
    const s = treeRes.status;
    const msg =
      s === 404 ? `Repository ${owner}/${repo} not found (or private).` :
      s === 409 ? `Repository ${owner}/${repo} is empty.` :
      s === 403 ? `GitHub API rate limit reached. Set a GITHUB_TOKEN env var in this val to raise the limit.` :
      `GitHub API error ${s} while fetching ${owner}/${repo}.`;
    return reply(msg, { error: msg }, s);
  }

  const data = await treeRes.json();
  const allFiles: { path: string; size: number | null }[] = data.tree
    .filter((item: any) => item.type === "blob")
    .map((item: any) => ({ path: item.path, size: item.size ?? null }));

  // Optional path filter: ?path=src/  (leading slashes are tolerated)
  const pathFilter = params.get("path")?.replace(/^\/+/, "") || null;
  const filtered = pathFilter
    ? allFiles.filter((f) => f.path.startsWith(pathFilter))
    : allFiles;

  // Pagination
  const parseNum = (v: string | null, def: number) => {
    const n = parseInt(v ?? "", 10);
    return Number.isNaN(n) ? def : n;
  };
  const DEFAULT_LIMIT = 500, MAX_LIMIT = 5000;
  const limit = Math.min(Math.max(parseNum(params.get("limit"), DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(parseNum(params.get("offset"), 0), 0);

  const page = filtered.slice(offset, offset + limit);
  const hasMore = offset + limit < filtered.length;
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`;

  let output = `REPOSITORY: ${owner}/${repo} (branch: ${branch})\n`;
  output += `FILES: ${page.length} shown, ${filtered.length} total`;
  output += pathFilter ? ` (filtered by "${pathFilter}")` : "";
  output += `\n`;
  if (data.truncated) output += `WARNING: GitHub API truncated this tree; listing may be incomplete.\n`;
  if (hasMore) {
    output += `MORE: ${filtered.length - offset - page.length} files not shown. `;
    output += `Repeat request with &offset=${offset + page.length} to get the next page.\n`;
  }
  output += `\n`;

  for (const item of page) {
    const size = item.size != null ? ` (${item.size} bytes)` : "";
    output += `${item.path}${size}\n  raw: ${rawBase}${item.path}\n`;
  }

  return reply(output, {
    repository: `${owner}/${repo}`,
    branch,
    total_files: filtered.length,
    github_truncated: data.truncated === true,
    offset,
    count: page.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + page.length } : {}),
    files: page.map((f) => ({ path: f.path, size: f.size, raw_url: rawBase + f.path })),
  });
}
