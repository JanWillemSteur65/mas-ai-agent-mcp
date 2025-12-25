
const $ = (id)=>document.getElementById(id);

const state = {
  page: "chat",
  theme: localStorage.getItem("theme") || "light",
  provider: localStorage.getItem("provider") || "openai",
  model: localStorage.getItem("model") || "",
  system: localStorage.getItem("system") || "",
  temp: Number(localStorage.getItem("temp") || "0.7"),
  mcpUrl: localStorage.getItem("mcpUrl") || "http://mcp-server:8081",
  mcpTools: localStorage.getItem("mcpTools") === "true",
  os: localStorage.getItem("os") || "mxapiasset"
};

function setTheme(t){
  state.theme=t;
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("theme", t);
}
setTheme(state.theme);

function navTo(p){
  state.page=p;
  document.querySelectorAll("[data-page]").forEach(el=>{
    el.classList.toggle("hidden", el.dataset.page !== p);
  });
  document.querySelectorAll(".nav button[data-nav]").forEach(b=>{
    b.classList.toggle("active", b.dataset.nav===p);
  });
  $("pageTitle").textContent = ({
    chat:"AI Agent",
    settings:"Settings",
    rest:"REST Builder",
    trace:"Trace",
    help:"Help"
  })[p] || "AI Agent";
}
document.querySelectorAll(".nav button[data-nav]").forEach(b=>{
  b.addEventListener("click", ()=>navTo(b.dataset.nav));
});
$("toggleTheme").addEventListener("click", ()=>setTheme(state.theme==="dark"?"light":"dark"));

async function api(path, body){
  const r = await fetch(path, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body||{}) });
  const t = await r.text();
  let j=null;
  try{ j=JSON.parse(t);}catch{ j=null;}
  if(!r.ok) throw new Error(j? (j.detail||j.error||t) : t);
  return j || {};
}

async function loadSettings(){
  const s = await api("/api/settings/load",{});
  // hydrate UI visible fields
  $("provider").value = state.provider;
  $("model").value = state.model;
  $("temp").value = String(state.temp);
  $("system").value = state.system;
  $("mcpUrl").value = state.mcpUrl;
  $("mcpTools").checked = state.mcpTools;
  $("os").value = state.os;

  // tenants from server (PVC)
  const tenants = (s.settings && Array.isArray(s.settings.tenants)) ? s.settings.tenants : [];
  renderTenants(tenants);
}
function renderTenants(tenants){
  const tbody=$("tenantsBody");
  tbody.innerHTML="";
  tenants.forEach((t,idx)=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `<td>${t.id||""}</td><td>${t.label||""}</td><td>${t.maximoBaseUrl||""}</td><td>${t.org||""}</td><td>${t.site||""}</td>
    <td><button class="btn" data-edit="${idx}">Edit</button> <button class="btn" data-del="${idx}">Del</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("button[data-edit]").forEach(btn=>{
    btn.onclick=()=>{
      const t=tenants[Number(btn.dataset.edit)];
      $("tenantId").value=t.id||"";
      $("tenantLabel").value=t.label||"";
      $("tenantUrl").value=t.maximoBaseUrl||"";
      $("tenantOrg").value=t.org||"";
      $("tenantSite").value=t.site||"";
    };
  });
  tbody.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.onclick=async ()=>{
      tenants.splice(Number(btn.dataset.del),1);
      await saveSettings({ tenants });
      renderTenants(tenants);
    };
  });
  $("addTenant").onclick=async ()=>{
    const t={
      id:$("tenantId").value.trim(),
      label:$("tenantLabel").value.trim(),
      maximoBaseUrl:$("tenantUrl").value.trim(),
      org:$("tenantOrg").value.trim(),
      site:$("tenantSite").value.trim()
    };
    if(!t.id) return alert("Tenant ID required");
    const existing = tenants.find(x=>x.id===t.id);
    if(existing) Object.assign(existing,t); else tenants.push(t);
    await saveSettings({ tenants });
    renderTenants(tenants);
  };
}

async function saveSettings(extra){
  // persist UI state to PVC
  const payload = {
    ui: { },
    mcp: { url: state.mcpUrl, enableTools: state.mcpTools },
    maximo: { objectStructure: state.os }
  };
  if(extra && extra.tenants) payload.tenants = extra.tenants;
  await api("/api/settings", { payload });
}

$("saveSettings").onclick = async ()=>{
  state.provider=$("provider").value;
  state.model=$("model").value.trim();
  state.temp=Number($("temp").value||"0.7");
  state.system=$("system").value;
  state.mcpUrl=$("mcpUrl").value.trim();
  state.mcpTools=$("mcpTools").checked;
  state.os=$("os").value.trim() || "mxapiasset";

  localStorage.setItem("provider",state.provider);
  localStorage.setItem("model",state.model);
  localStorage.setItem("temp",String(state.temp));
  localStorage.setItem("system",state.system);
  localStorage.setItem("mcpUrl",state.mcpUrl);
  localStorage.setItem("mcpTools",String(state.mcpTools));
  localStorage.setItem("os",state.os);

  try{ await saveSettings(); alert("Saved"); }
  catch(e){ alert("Save failed: "+e.message); }
};

$("refreshModels").onclick = async ()=>{
  try{
    const out = await api("/api/models", { provider: $("provider").value });
    const models = out.models || [];
    const sel = $("model");
    sel.innerHTML = "";
    const opt0=document.createElement("option"); opt0.value=""; opt0.textContent="(select model)";
    sel.appendChild(opt0);
    models.slice(0,200).forEach(m=>{
      const o=document.createElement("option"); o.value=m; o.textContent=m;
      sel.appendChild(o);
    });
    if(state.model) sel.value = state.model;
    if(out.warning) $("modelsNote").textContent = "Note: "+out.warning;
    else $("modelsNote").textContent="";
  }catch(e){
    $("modelsNote").textContent = "Models fetch failed: "+e.message;
  }
};

const chatEl = $("chat");
function addBubble(role, content){
  const row=document.createElement("div");
  row.className = "bubbleRow "+(role==="user"?"user":"ai");
  const b=document.createElement("div");
  b.className = "bubble "+(role==="user"?"user":"ai");
  if(content && content.__table){
    b.appendChild(renderTable(content.__table));
  }else{
    b.textContent = content || "";
  }
  row.appendChild(b);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderTable(t){
  const wrap=document.createElement("div");
  wrap.className="tableWrap";
  const table=document.createElement("table");
  const thead=document.createElement("thead");
  const trh=document.createElement("tr");
  (t.columns||[]).forEach(c=>{
    const th=document.createElement("th"); th.textContent = String(c).toUpperCase();
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  const tbody=document.createElement("tbody");
  (t.rows||[]).forEach(r=>{
    const tr=document.createElement("tr");
    (t.columns||[]).forEach(c=>{
      const td=document.createElement("td");
      td.textContent = (r && r[c] != null) ? String(r[c]) : "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(thead); table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

const maximoPrompts = [
  { label:"Show me all assets", text:"show all assets" },
  { label:"Show me all locations", text:"show all locations" },
  { label:"Show me all open work orders", text:"show all open work orders" },
  { label:"Show me all service requests", text:"show all service requests" }
];
function loadChips(){
  const box=$("chips");
  box.innerHTML="";
  maximoPrompts.forEach(p=>{
    const c=document.createElement("button");
    c.className="chip";
    c.textContent=p.label;
    c.onclick=()=>{ $("prompt").value=p.text; $("send").click(); };
    box.appendChild(c);
  });
}
loadChips();

$("send").onclick = async ()=>{
  const txt = $("prompt").value.trim();
  if(!txt) return;
  $("prompt").value="";
  addBubble("user", txt);

  try{
    if(state.mcpTools){
      const out = await api("/api/agent/chat", {
        provider: state.provider,
        model: state.model,
        temperature: state.temp,
        system: state.system,
        text: txt
      });
      addBubble("ai", out.reply || "");
    }else{
      // direct Maximo in "predefined Maximo prompt" style
      const out = await api("/api/maximo/query", { os: state.os, text: txt });
      if(out.table) addBubble("ai", { __table: out.table });
      else addBubble("ai", out.summary || "OK");
    }
  }catch(e){
    addBubble("ai", "Error: "+e.message);
  }
};

$("clearChat").onclick = ()=>{ chatEl.innerHTML=""; };

navTo("chat");
loadSettings().catch(()=>{});
