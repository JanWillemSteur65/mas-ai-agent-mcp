#!/usr/bin/env node
/**
 * Maximo AI Agent (no external npm deps)
 * - Serves static UI from ./public
 * - Settings persisted to PVC file (SETTINGS_FILE)
 * - Secrets via env override PVC ("secure hybrid": env wins)
 * - OpenAI-compatible AI providers (OpenAI/Mistral/DeepSeek) with tool calling
 * - MCP orchestration (tools + call) with defensive tool normalization
 */
import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "public");
const SETTINGS_DIR = process.env.SETTINGS_DIR || "/opt/app-root/settings";
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(SETTINGS_DIR, "settings.json");

const MCP_URL_DEFAULT = process.env.MCP_URL || "http://mcp-server:8081";

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function text(res, status, body, ctype="text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": ctype, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let data="";
    req.on("data", c => { data += c; if (data.length > 10_000_000) { reject(new Error("body too large")); req.destroy(); }});
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function ensureSettingsFile() {
  try { await mkdir(SETTINGS_DIR, { recursive: true }); } catch {}
  if (!existsSync(SETTINGS_FILE)) {
    const init = { ui:{}, tenants:[], maximo:{}, mcp:{ url: MCP_URL_DEFAULT, enableTools:false } };
    await writeFile(SETTINGS_FILE, JSON.stringify(init, null, 2), "utf-8");
  }
}

async function loadSettingsRaw() {
  await ensureSettingsFile();
  try {
    const s = await readFile(SETTINGS_FILE, "utf-8");
    return JSON.parse(s);
  } catch {
    return { ui:{}, tenants:[], maximo:{}, mcp:{ url: MCP_URL_DEFAULT, enableTools:false } };
  }
}

function applyEnvOverrides(s) {
  const out = structuredClone(s);
  out.ai = out.ai || {};
  out.maximo = out.maximo || {};
  out.mcp = out.mcp || {};
  out.tenants = Array.isArray(out.tenants) ? out.tenants : [];

  // AI provider env overrides (optional)
  if (process.env.OPENAI_API_KEY) out.ai.openai_key = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_BASE) out.ai.openai_base = process.env.OPENAI_BASE;
  if (process.env.MISTRAL_API_KEY) out.ai.mistral_key = process.env.MISTRAL_API_KEY;
  if (process.env.MISTRAL_BASE) out.ai.mistral_base = process.env.MISTRAL_BASE;
  if (process.env.DEEPSEEK_API_KEY) out.ai.deepseek_key = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_BASE) out.ai.deepseek_base = process.env.DEEPSEEK_BASE;

  // Maximo env overrides
  if (process.env.MAXIMO_URL) out.maximo.baseUrl = process.env.MAXIMO_URL;
  if (process.env.MAXIMO_APIKEY) out.maximo.apiKey = process.env.MAXIMO_APIKEY;
  if (process.env.DEFAULT_SITEID) out.maximo.defaultSite = process.env.DEFAULT_SITEID;
  if (process.env.DEFAULT_TENANT) out.maximo.defaultTenant = process.env.DEFAULT_TENANT;

  // MCP env overrides
  if (process.env.MCP_URL) out.mcp.url = process.env.MCP_URL;
  if (process.env.MCP_ENABLE_TOOLS) out.mcp.enableTools = String(process.env.MCP_ENABLE_TOOLS).toLowerCase()==="true";
  return out;
}

async function effectiveSettings() {
  const raw = await loadSettingsRaw();
  return applyEnvOverrides(raw);
}

async function saveSettingsFromUI(payload) {
  // Persist only non-secret UI configuration to PVC (hybrid model)
  const cur = await loadSettingsRaw();
  const next = structuredClone(cur);

  if (payload && typeof payload === "object") {
    if (payload.ui && typeof payload.ui === "object") next.ui = { ...(next.ui||{}), ...payload.ui };
    if (payload.maximo && typeof payload.maximo === "object") {
      next.maximo = { ...(next.maximo||{}), ...payload.maximo };
      // do not persist apiKey by default (Secrets override). Keep if you explicitly need it:
      delete next.maximo.apiKey;
    }
    if (payload.mcp && typeof payload.mcp === "object") next.mcp = { ...(next.mcp||{}), ...payload.mcp };
    if (Array.isArray(payload.tenants)) next.tenants = payload.tenants.map(t => ({
      id: String(t.id||"").trim(),
      label: String(t.label||"").trim(),
      maximoBaseUrl: String(t.maximoBaseUrl||"").trim(),
      org: String(t.org||"").trim(),
      site: String(t.site||"").trim()
    })).filter(t => t.id);
  }

  await ensureSettingsFile();
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/* ---------------- Tool schema normalization ---------------- */
function toOpenAITools(rawTools) {
  const list = Array.isArray(rawTools) ? rawTools : [];
  const out = [];
  for (const t of list) {
    if (t && t.type === "function" && t.function && t.function.name) {
      out.push({
        type: "function",
        function: {
          name: String(t.function.name),
          description: String(t.function.description || ""),
          parameters: (t.function.parameters && typeof t.function.parameters === "object")
            ? t.function.parameters
            : { type:"object", properties:{}, additionalProperties:true }
        }
      });
      continue;
    }
    const name = String(t?.name || "").trim();
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: String(t?.description || ""),
        parameters: (t?.inputSchema && typeof t.inputSchema === "object")
          ? t.inputSchema
          : { type:"object", properties:{}, additionalProperties:true }
      }
    });
  }
  return out;
}

function providerConfig(provider, s) {
  const p = String(provider||"openai").toLowerCase();
  const baseDefaults = {
    openai: "https://api.openai.com",
    mistral: "https://api.mistral.ai",
    deepseek: "https://api.deepseek.com"
  };
  const cfg = { provider: p };
  const ai = s.ai || {};
  if (p === "openai") { cfg.key = ai.openai_key || ""; cfg.base = ai.openai_base || baseDefaults.openai; }
  else if (p === "mistral") { cfg.key = ai.mistral_key || ""; cfg.base = ai.mistral_base || baseDefaults.mistral; }
  else if (p === "deepseek") { cfg.key = ai.deepseek_key || ""; cfg.base = ai.deepseek_base || baseDefaults.deepseek; }
  else { cfg.key = ""; cfg.base = ""; }
  cfg.base = String(cfg.base||"").trim().replace(/\/$/,"");
  return cfg;
}

async function fetchJson(url, options) {
  const r = await fetch(url, options);
  const t = await r.text();
  let j=null;
  try { j = JSON.parse(t); } catch { j = null; }
  return { ok: r.ok, status: r.status, text: t, json: j, headers: r.headers };
}

async function openaiCompatChat({ cfg, model, temperature, messages, tools }) {
  if (!cfg.key) throw new Error(`missing_api_key:${cfg.provider}`);
  const body = {
    model: model || "gpt-4o-mini",
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7,
    messages
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const r = await fetchJson(`${cfg.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type":"application/json", "authorization": `Bearer ${cfg.key}` },
    body: JSON.stringify(body)
  });
  if (!r.ok || !r.json) {
    throw new Error(`AI request failed (${r.status}). ${r.text.slice(0,300)}`);
  }
  return r.json;
}

/* ---------------- Maximo helpers ---------------- */
function normMaximoBase(u) {
  let s = String(u||"").trim().replace(/\/$/,"");
  if (!s) return "";
  if (!/\/maximo$/.test(s)) s = `${s}/maximo`;
  return s;
}
function maximoApiBase(u) {
  const b = normMaximoBase(u);
  return b ? b.replace(/\/maximo$/, "/maximo/api") : "";
}
function normalizeOrderBy(orderBy) {
  const s = String(orderBy||"").trim();
  if (!s) return "";
  if (s.startsWith("+") || s.startsWith("-")) return s;
  const m = s.match(/^([a-zA-Z0-9_\.]+)\s+(asc|desc)$/i);
  if (m) return (m[2].toLowerCase()==="desc" ? `-${m[1]}` : `+${m[1]}`);
  return `+${s}`;
}

/* ---------------- HTTP routing ---------------- */
async function serveStatic(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  p = p.replace(/\.\./g, ""); // basic traversal guard
  const fp = path.join(PUBLIC_DIR, p);
  try {
    const st = await stat(fp);
    if (!st.isFile()) throw new Error("not file");
    const buf = await readFile(fp);
    const ext = path.extname(fp).toLowerCase();
    const ctype = ext===".html" ? "text/html; charset=utf-8"
      : ext===".js" ? "application/javascript; charset=utf-8"
      : ext===".css" ? "text/css; charset=utf-8"
      : ext===".svg" ? "image/svg+xml"
      : "application/octet-stream";
    res.writeHead(200, { "content-type": ctype, "content-length": buf.length });
    res.end(buf);
  } catch {
    // SPA fallback to index.html
    try {
      const buf = await readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "content-type":"text/html; charset=utf-8", "content-length": buf.length });
      res.end(buf);
    } catch {
      text(res, 500, "UI not present in image.");
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    // Health
    if (req.method==="GET" && u.pathname==="/healthz") return text(res, 200, "ok");

    // Settings
    if (req.method==="POST" && u.pathname==="/api/settings/load") {
      const s = await effectiveSettings();
      return json(res, 200, { settings: s });
    }
    if (req.method==="POST" && u.pathname==="/api/settings") {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const next = await saveSettingsFromUI(parsed.payload ?? parsed ?? {});
      return json(res, 200, { ok:true, settings: next });
    }
    if (req.method==="POST" && u.pathname==="/api/models") {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const provider = String(parsed.provider||"openai").toLowerCase();
      const s = await effectiveSettings();
      const cfg = providerConfig(provider, s);

      // Use curated if missing key or models fetch fails
      const curated = {
        openai: ["gpt-4o-mini","gpt-4o","gpt-4.1-mini","gpt-4.1"],
        mistral: ["mistral-large-latest","mistral-small-latest","open-mistral-nemo"],
        deepseek: ["deepseek-chat","deepseek-reasoner"]
      };

      if (!cfg.key) return json(res, 200, { models: curated[provider]||curated.openai, warning:"missing_api_key" });

      const r = await fetchJson(`${cfg.base}/v1/models`, { headers: { authorization: `Bearer ${cfg.key}` } });
      if (!r.ok || !r.json) return json(res, 200, { models: curated[provider]||curated.openai, warning:`models_failed_${r.status}` });

      const ids = Array.isArray(r.json.data) ? r.json.data.map(x=>x.id).filter(Boolean) : [];
      return json(res, 200, { models: ids.length?ids:(curated[provider]||curated.openai) });
    }

    // Agent chat (AI mode)
    if (req.method==="POST" && u.pathname==="/api/agent/chat") {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const s = await effectiveSettings();

      const provider = String(parsed.provider||"openai").toLowerCase();
      const cfg = providerConfig(provider, s);
      if (!cfg.key) return json(res, 400, { error:"missing_api_key", detail:`Missing ${provider} API key` });

      const model = String(parsed.model||"").trim();
      const temperature = parsed.temperature ?? 0.7;
      const system = String(parsed.system||"").trim();
      const textIn = String(parsed.text||"").trim();
      if (!textIn) return json(res, 400, { error:"missing_text" });

      const messages = [];
      if (system) messages.push({ role:"system", content: system });
      messages.push({ role:"user", content: textIn });

      const mcpUrl = String(s.mcp?.url || MCP_URL_DEFAULT).trim().replace(/\/$/,"");
      const enableTools = !!s.mcp?.enableTools;
      const tenant = String(s.maximo?.defaultTenant || "default");

      let tools = [];
      if (enableTools && mcpUrl) {
        const tr = await fetchJson(`${mcpUrl}/mcp/tools?tenant=${encodeURIComponent(tenant)}`, { method:"GET" });
        const rawTools = (tr.ok && tr.json && Array.isArray(tr.json.tools)) ? tr.json.tools : [];
        tools = toOpenAITools(rawTools); // defensive conversion ALWAYS
      }

      const out1 = await openaiCompatChat({ cfg, model, temperature, messages, tools: tools.length?tools:undefined });
      const msg = out1?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      if (!toolCalls.length) {
        return json(res, 200, { reply: String(msg.content||"") });
      }

      // Execute tool calls via MCP, then send follow-up
      const follow = [...messages, msg];
      for (const tc of toolCalls) {
        const name = tc?.function?.name;
        const argsStr = tc?.function?.arguments || "{}";
        let args={};
        try { args = JSON.parse(argsStr); } catch { args = { raw: argsStr }; }

        const cr = await fetchJson(`${mcpUrl}/mcp/call`, {
          method:"POST",
          headers:{ "content-type":"application/json" },
          body: JSON.stringify({ name, args, tenant })
        });

        follow.push({
          role: "tool",
          tool_call_id: tc.id,
          content: cr.json ? JSON.stringify(cr.json) : String(cr.text||"")
        });
      }

      const out2 = await openaiCompatChat({ cfg, model, temperature, messages: follow });
      const finalMsg = out2?.choices?.[0]?.message?.content || "";
      return json(res, 200, { reply: String(finalMsg) });
    }

    // Maximo query (direct)
    if (req.method==="POST" && u.pathname==="/api/maximo/query") {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const s = await effectiveSettings();

      const baseUrl = s.maximo?.baseUrl;
      const apiKey = s.maximo?.apiKey;
      if (!baseUrl || !apiKey) return json(res, 400, { error:"missing_maximo_config", detail:"Set MAXIMO_URL and MAXIMO_APIKEY as env/secret." });

      const api = maximoApiBase(baseUrl);
      const os = String(parsed.os || "mxapiasset").trim();
      const site = String(s.maximo?.defaultSite || "").toUpperCase();

      // simple defaults
      let where = site ? `siteid="${site}"` : "";
      let select = "assetnum,description,siteid,location,status,assettype,changedate";
      let orderBy = "-changedate";
      let pageSize = "100";

      const params = new URLSearchParams();
      if (where) params.set("oslc.where", where);
      if (select) params.set("oslc.select", select);
      if (orderBy) params.set("oslc.orderBy", normalizeOrderBy(orderBy));
      if (pageSize) params.set("oslc.pageSize", pageSize);

      const url = `${api}/os/${encodeURIComponent(os)}?${params.toString()}`;
      const r = await fetchJson(url, { headers: { accept:"application/json", apikey: apiKey }});
      if (!r.ok || !r.json) return json(res, r.status||500, { error:"maximo_failed", detail:r.text?.slice(0,600), url });

      const member = r.json.member || r.json["rdfs:member"] || [];
      const rows = Array.isArray(member) ? member : [];
      const cols = select.split(",").map(x=>x.trim()).filter(Boolean);
      const data = rows.map(o => Object.fromEntries(cols.map(c => [c, o?.[c] ?? ""])));
      return json(res, 200, { summary:`Retrieved ${data.length} row(s) from Maximo.`, table:{ title:`Results · ${os}`, columns: cols, rows: data }});
    }

    // Static UI
    if (req.method==="GET") return await serveStatic(req, res);

    return text(res, 404, "Not Found");
  } catch (e) {
    return json(res, 500, { error:"server_error", detail: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`AI Agent listening on ${PORT}`);
  console.log(`SETTINGS_FILE=${SETTINGS_FILE}`);
});
