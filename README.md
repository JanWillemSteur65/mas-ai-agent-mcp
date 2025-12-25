# Maximo AI Agent + MCP Server (OpenShift)

This repository deploys:
- **AI Agent** (UI + API) on port 8080
- **MCP Server** (tool orchestration to Maximo) on port 8081
- **PVC-backed settings.json** (tenants registry + non-secret UI config)
- **Secret-based credentials** (Secrets override PVC at runtime)

## Key design choices (prevents your previous errors)
- **No npm installs during OpenShift builds** (no ECONNRESET / proxy failures).
- **No external runtime dependencies** (Node 20 built-ins only).
- **MCP `/mcp/tools` returns OpenAI-ready tools** to avoid 422 validation errors.
- **AI Agent also defensively normalizes tool schemas** so MCP/tool schema drift cannot break AI calls.
- **In-cluster MCP URL recommended**: `http://mcp-server:8081` (avoids self-signed TLS chain issues).

---

## 0) Create project

```bash
oc new-project maximo-ai-agent
```

---

## 1) Apply foundational resources

```bash
oc -n maximo-ai-agent apply -f openshift/10-pvc.yaml
oc -n maximo-ai-agent apply -f openshift/20-secrets.yaml
oc -n maximo-ai-agent apply -f openshift/30-imagestreams.yaml
oc -n maximo-ai-agent apply -f openshift/40-buildconfigs.yaml
```

### Update secrets with real values
Edit `openshift/20-secrets.yaml` and set:
- `MAXIMO_URL` (must include `/maximo` or base host; code normalizes)
- `MAXIMO_APIKEY`
- `DEFAULT_SITEID` (e.g. `BIKES`)
- One of: `OPENAI_API_KEY` / `MISTRAL_API_KEY` / `DEEPSEEK_API_KEY`

Apply again:

```bash
oc -n maximo-ai-agent apply -f openshift/20-secrets.yaml
```

---

## 2) Build images (binary build)

From the **root of the unzipped repo**:

```bash
oc -n maximo-ai-agent start-build app --from-dir=app --follow
oc -n maximo-ai-agent start-build mcp-server --from-dir=mcp-server --follow
```

These builds do **not** run `npm install`; they only copy files into UBI Node.js.

---

## 3) Deploy

```bash
oc -n maximo-ai-agent apply -f openshift/50-deployments.yaml
oc -n maximo-ai-agent apply -f openshift/60-services.yaml
oc -n maximo-ai-agent apply -f openshift/70-routes.yaml
```

Wait for readiness:

```bash
oc -n maximo-ai-agent get pods
oc -n maximo-ai-agent rollout status deploy/app
oc -n maximo-ai-agent rollout status deploy/mcp-server
```

---

## 4) Validate MCP tool schema (must be OpenAI-ready)

```bash
oc -n maximo-ai-agent run curltest --rm -i --restart=Never --image=curlimages/curl --   sh -lc 'curl -sS http://mcp-server:8081/mcp/tools?tenant=default | head -c 300'
```

Expected to include:

```json
{"tools":[{"type":"function","function":{"name":"maximo.listOS"
```

---

## 5) Open the UI

Get the route:

```bash
oc -n maximo-ai-agent get route app
```

Open the URL in a browser.

### Settings in the UI
- Provider: OpenAI / Mistral / DeepSeek
- Retrieve models (uses `/v1/models` if key present, else curated list)
- MCP Server URL: `http://mcp-server:8081`
- Enable MCP orchestration: on/off
- Tenants registry: add tenants and save (stored in PVC)

---

## 6) PVC settings.json (what it should look like)

The server creates it automatically at:

`/opt/app-root/settings/settings.json`

Example is included at:

`openshift/settings.example.json`

If you want to seed it:

```bash
# copy from local file into the running app pod (requires oc cp)
POD=$(oc -n maximo-ai-agent get pod -l component=app -o jsonpath='{.items[0].metadata.name}')
oc -n maximo-ai-agent cp openshift/settings.example.json $POD:/opt/app-root/settings/settings.json
oc -n maximo-ai-agent rollout restart deploy/app
oc -n maximo-ai-agent rollout restart deploy/mcp-server
```

---

## Troubleshooting

### AI request failed (422)
This should not happen in this build. If it does:
1. Verify MCP tools endpoint returns `type:function` as shown in step 4.
2. Ensure UI MCP URL points to **internal** `http://mcp-server:8081`.

### AI request failed with HTML (`Unexpected token '<'`)
This indicates a wrong AI base URL. Reset bases in the secret:
- `OPENAI_BASE=https://api.openai.com`
- `MISTRAL_BASE=https://api.mistral.ai`

### Maximo OSLC 400 for orderBy
This build uses `-changedate` style (MAS-friendly). If your instance expects different orderBy syntax, adjust in `app/server.mjs` normalization.

---
