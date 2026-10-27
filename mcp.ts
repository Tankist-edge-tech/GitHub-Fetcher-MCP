// MCP server — exposes the github-fetcher HTTP val as native AI tools
// (e.g. via a Claude "custom connector").
//
// Setup: point FETCHER at YOUR deployed github-fetcher HTTP val, either by
// setting a FETCHER_URL env var in this val, or by editing the fallback below.

const FETCHER = Deno.env.get("FETCHER_URL") ?? "https://your-fetcher-val.val.run";

const TOOLS = [
  {
    name: "list_repo_files",
    description:
      "List files of a public GitHub repository: path, size, and raw URL per file. " +
      "Use 'path' to scope to a subfolder (recursive). Paginate with offset.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub username or org, e.g. facebookresearch" },
        repo: { type: "string", description: "Repository name, e.g. tribev2" },
        path: { type: "string", description: "Optional folder filter, relative to repo root, e.g. src/" },
        limit: { type: "number", description: "Max files per page (default 200, max 5000)" },
        offset: { type: "number", description: "Skip the first N files (next page from previous result)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "fetch_repo_file",
    description:
      "Fetch the full text content of one file from a public GitHub repo. " +
      "Paths are case-sensitive, relative to repo root.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        file: { type: "string", description: "File path, e.g. src/index.ts" },
      },
      required: ["owner", "repo", "file"],
    },
  },
  {
    name: "fetch_repo_readme",
    description:
      "Fetch the README of a public GitHub repo (works regardless of readme filename/format).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
];

async function callTool(name: string, args: any): Promise<string> {
  const owner = encodeURIComponent(args?.owner ?? "");
  const repo = encodeURIComponent(args?.repo ?? "");
  const q = new URLSearchParams();
  if (args?.path) q.set("path", String(args.path));
  q.set("limit", String(Math.min(Number(args?.limit) || 200, 5000)));
  if (args?.offset) q.set("offset", String(args.offset));

  let url: string;
  if (name === "list_repo_files") {
    url = `${FETCHER}?owner=${owner}&repo=${repo}&${q}`;
  } else if (name === "fetch_repo_file") {
    url = `${FETCHER}?owner=${owner}&repo=${repo}&file=${encodeURIComponent(String(args?.file ?? ""))}`;
  } else if (name === "fetch_repo_readme") {
    url = `${FETCHER}?owner=${owner}&repo=${repo}&readme`;
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }
  const res = await fetch(url);
  return await res.text();
}

function json(obj: any) {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
}
function rpcErr(id: any, code: number, message: string) {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

export default async function(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("MCP endpoint: use POST", { status: 405 });

  let msg: any;
  try { msg = await req.json(); } catch {
    return rpcErr(null, -32700, "Parse error");
  }
  const { id, method, params } = msg;

  // Notifications (no id) expect no body back
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  if (method === "initialize") {
    return json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "github-fetcher", version: "1.0.0" },
      },
    });
  }
  if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    try {
      const text = await callTool(name, args ?? {});
      return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e: any) {
      // Tool failures go in the result (isError), not as JSON-RPC errors
      return json({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true },
      });
    }
  }
  return rpcErr(id, -32601, `Method not found: ${method}`);
}
