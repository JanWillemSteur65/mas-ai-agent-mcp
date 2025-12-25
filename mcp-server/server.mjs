#!/usr/bin/env node
/**
 * MCP Server (no external npm deps)
 * - /mcp/tools returns OpenAI-ready tool schema
 * - /mcp/call executes tools against Maximo (/maximo/api/os)
 * - Reads tenant registry from SETTINGS_FILE (PVC mounted)
 */
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8081);
const SETTINGS_DIR = process.env.SETTINGS_DIR || "/opt/app-root/settings";
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(SETTINGS_DIR, "settings.json");

function json(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type":"application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function text(res, status, body){
  res.writeHead(status, { "content-type":"text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
async function readBody(req){
  return await new Promise((resolve,reject)=>{
    let d=""; req.on("data",c=>{d+=c; if(d.length>10_000_000){reject(new Error("body too large")); req.destroy();}});
    req.on("end",()=>resolve(d)); req.on("error",reject);
  });
}
async function ensureSettings(){
  try{ await mkdir(SETTINGS_DIR,{recursive:true}); }catch{}
  if(!existsSync(SETTINGS_FILE)){
    const init={ ui:{}, tenants:[], maximo:{}, mcp:{ enableTools:true } };
    await writeFile(SETTINGS_FILE, JSON.stringify(init,null,2), "utf-8");
  }
}
async function loadSettings(){
  await ensureSettings();
  try{ return JSON.parse(await readFile(SETTINGS_FILE,"utf-8")); }catch{ return { tenants:[], maximo:{} }; }
}
function normMaximoBase(u){
  let s=String(u||"").trim().replace(/\/$/,"");
  if(!s) return "";
  if(!/\/maximo$/.test(s)) s = `${s}/maximo`;
  return s;
}
function maximoApiBase(u){
  const b=normMaximoBase(u);
  return b? b.replace(/\/maximo$/,"/maximo/api") : "";
}
function resolveTenant(settings, tenantId){
  const tenants = Array.isArray(settings.tenants)?settings.tenants:[];
  const def = String(settings.maximo?.defaultTenant || "default");
  const id = String(tenantId || def || "default");
  const t = tenants.find(x=>String(x.id)===id) || tenants.find(x=>String(x.id)==="default") || {};
  // API key is expected from env secret primarily; allow optional in settings.maximo.apiKey
  const baseUrl = t.maximoBaseUrl || settings.maximo?.baseUrl || process.env.MAXIMO_URL || "";
  const apiKey = process.env.MAXIMO_APIKEY || settings.maximo?.apiKey || "";
  const site = (t.site || settings.maximo?.defaultSite || process.env.DEFAULT_SITEID || "").toString().toUpperCase();
  return { id, baseUrl: normMaximoBase(baseUrl), apiBase: maximoApiBase(baseUrl), apiKey, site, org: t.org || "" };
}

const MCP_NATIVE_TOOLS = [
  { name:"maximo.listOS", description:"List object structures (/os).",
    inputSchema:{ type:"object", properties:{}, additionalProperties:false } },
  { name:"maximo.queryOS", description:"Query an object structure with OSLC params.",
    inputSchema:{ type:"object", properties:{
      os:{ type:"string", description:"Object Structure name (e.g., mxapiasset, mxapiwo)" },
      params:{ type:"object", description:"OSLC query params (oslc.where, oslc.select, oslc.orderBy, oslc.pageSize)" }
    }, required:["os"], additionalProperties:false } }
];

function mcpToOpenAITools(list){
  const arr = Array.isArray(list)?list:[];
  return arr.map(t=>({
    type:"function",
    function:{
      name: String(t.name||""),
      description: String(t.description||""),
      parameters: (t.inputSchema && typeof t.inputSchema==="object") ? t.inputSchema : { type:"object", properties:{}, additionalProperties:true }
    }
  })).filter(x=>x.function.name);
}

async function fetchJson(url, options){
  const r = await fetch(url, options);
  const txt = await r.text();
  let j=null; try{ j=JSON.parse(txt);}catch{ j=null;}
  return { ok:r.ok, status:r.status, text:txt, json:j };
}

const server = http.createServer(async (req,res)=>{
  try{
    const u = new URL(req.url, `http://${req.headers.host}`);

    if(req.method==="GET" && u.pathname==="/healthz") return text(res,200,"ok");

    if(req.method==="GET" && u.pathname==="/mcp/tools"){
      const settings = await loadSettings();
      // tenant param accepted for future filtering; currently same tools for all tenants
      return json(res,200,{ tools: mcpToOpenAITools(MCP_NATIVE_TOOLS) });
    }

    if(req.method==="POST" && u.pathname==="/mcp/call"){
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const name = String(parsed.name||"").trim();
      const args = parsed.args || {};
      const tenantId = parsed.tenant;

      const settings = await loadSettings();
      const tenant = resolveTenant(settings, tenantId);

      if(!name) return json(res,400,{ error:"missing_tool_name" });
      if(!tenant.apiBase || !tenant.apiKey) return json(res,400,{ error:"missing_maximo_config", detail:"MAXIMO_URL and MAXIMO_APIKEY must be provided (secret/env) or in settings.json." });

      if(name==="maximo.listOS"){
        const url = `${tenant.apiBase}/os`;
        const r = await fetchJson(url,{ headers:{ accept:"application/json", apikey: tenant.apiKey }});
        if(!r.ok || !r.json) return json(res,r.status||500,{ error:"maximo_failed", detail:r.text.slice(0,600), url });
        return json(res,200,{ ok:true, tenant:tenant.id, list:r.json });
      }

      if(name==="maximo.queryOS"){
        const os = String(args.os||"").trim();
        const paramsIn = (args.params && typeof args.params==="object") ? args.params : {};
        if(!os) return json(res,400,{ error:"missing_os" });

        const params = new URLSearchParams();
        const where = String(paramsIn["oslc.where"] || "").trim() || (tenant.site ? `siteid="${tenant.site}"` : "");
        const select = String(paramsIn["oslc.select"] || "").trim();
        const orderBy = String(paramsIn["oslc.orderBy"] || "").trim();
        const pageSize = String(paramsIn["oslc.pageSize"] || "").trim();

        if(where) params.set("oslc.where", where);
        if(select) params.set("oslc.select", select);
        if(orderBy) params.set("oslc.orderBy", orderBy);
        if(pageSize) params.set("oslc.pageSize", pageSize);

        const url = `${tenant.apiBase}/os/${encodeURIComponent(os)}?${params.toString()}`;
        const r = await fetchJson(url,{ headers:{ accept:"application/json", apikey: tenant.apiKey }});
        if(!r.ok || !r.json) return json(res,r.status||500,{ error:"maximo_failed", detail:r.text.slice(0,800), url });

        return json(res,200,{ ok:true, tenant:tenant.id, os, data:r.json, trace:{ request:{ method:"GET", url, headers:{ apikey:"***" }}}});
      }

      return json(res,404,{ error:"unknown_tool", name });
    }

    return text(res,404,"Not Found");
  }catch(e){
    return json(res,500,{ error:"mcp_error", detail:String(e?.message||e) });
  }
});

server.listen(PORT, ()=>console.log(`MCP server listening on ${PORT}`));
