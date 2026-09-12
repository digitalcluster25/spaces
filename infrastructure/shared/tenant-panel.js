const crypto = require("crypto");

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter((entry) => entry.length === 2));
}

function readSignedContext(req, secret) {
  const raw = parseCookies(req.headers.cookie).spaces_project_context || "";
  const [payload, signature] = raw.split(".");
  if (!payload || !signature || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const context = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return context.exp > Date.now() && context.projectId ? context : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function panelCss() {
  return `*{box-sizing:border-box}html,body{margin:0;height:44px;overflow:hidden;background:#fff;color:#18181b;font:12px ui-sans-serif,system-ui,-apple-system,sans-serif}.bar{height:44px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid #e4e4e7;white-space:nowrap}.brand{font-weight:750;font-size:13px;text-decoration:none;color:#18181b}.divider{width:1px;height:20px;background:#e4e4e7}.identity{display:grid;line-height:1.15;max-width:220px}.identity small,.muted{color:#71717a;font-size:9px;text-transform:uppercase}.identity b{overflow:hidden;text-overflow:ellipsis}.project{position:relative;display:grid;line-height:1.1}.project span{color:#71717a;font-size:9px;text-transform:uppercase}.project select{max-width:220px;height:22px;padding:0 18px 0 0;border:0;background:#fff;color:#18181b;font:650 12px ui-sans-serif,system-ui;appearance:none}.project:after{content:'⌄';position:absolute;right:2px;bottom:3px;pointer-events:none}.bar nav{display:flex;align-items:center;justify-content:flex-end;gap:3px;margin-left:auto}.bar nav a,.current,.pending{display:inline-flex;align-items:center;gap:5px;padding:7px 9px;border-radius:5px;text-decoration:none;color:#18181b;font-weight:650}.bar nav a:hover{background:#f4f4f5}.current{background:#18181b;color:#fff}.pending{color:#71717a}.dot{width:6px;height:6px;border-radius:50%;background:#a1a1aa}.status-ready .dot{background:#18181b}.settings{border:1px solid #e4e4e7}#toggle{width:28px;height:28px;border:1px solid #e4e4e7;border-radius:5px;background:#fff;cursor:pointer}.collapsed .bar{height:12px;justify-content:flex-end;padding:0}.collapsed .bar>*:not(#toggle){display:none}.collapsed #toggle{width:34px;height:12px;border-width:0 0 0 1px;border-radius:0;font-size:10px;line-height:10px}@media(max-width:760px){.identity{display:none}.bar{gap:7px;padding:0 8px}.bar nav{overflow:auto}.bar nav a,.current,.pending{padding:7px 6px}.settings{display:none}}`;
}

function panelScript(currentService) {
  const service = JSON.stringify(String(currentService || ""));
  return `<script>const key="spaces:tenant-panel-collapsed";const button=document.getElementById("toggle");const apply=(value)=>{document.documentElement.classList.toggle("collapsed",value);button.textContent=value?"⌄":"⌃";parent.postMessage({type:"spaces-tenant-height",height:value?12:44},location.origin);localStorage.setItem(key,value?"1":"0")};button.onclick=()=>apply(localStorage.getItem(key)!=="1");apply(localStorage.getItem(key)==="1");const project=document.getElementById("project");if(project)project.onchange=()=>window.open("https://spaces.community/launch?project="+encodeURIComponent(project.value)+"&service="+encodeURIComponent(${service}),"_top");</script>`;
}

function createPanelPage(context, currentService) {
  const toggle = `<button id="toggle" title="Свернуть панель" aria-label="Свернуть панель">⌃</button>`;
  if (!context) {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${panelCss()}</style></head><body><div class="bar"><a class="brand" href="https://spaces.community/account" target="_blank" rel="noopener">Spaces</a><span class="muted">Откройте сервис из аккаунта Spaces</span>${toggle}</div>${panelScript(currentService)}</body></html>`;
  }

  const projectId = encodeURIComponent(context.projectId);
  const services = Array.isArray(context.services) ? context.services : [];
  const projects = Array.isArray(context.projects) ? context.projects : [];
  const links = services.map((service) => {
    const slug = encodeURIComponent(String(service.slug || ""));
    const name = escapeHtml(service.name);
    const status = String(service.status || "provisioning");
    if (service.slug === currentService) return `<strong class="current">${name}</strong>`;
    if (status !== "ready") return `<span class="pending status-${escapeHtml(status)}"><i class="dot"></i>${name}</span>`;
    return `<a class="status-ready" href="https://spaces.community/launch?project=${projectId}&service=${slug}" target="_blank" rel="noopener"><i class="dot"></i>${name}</a>`;
  }).join("");
  const projectOptions = projects.map((project) => {
    const selected = project.id === context.projectId ? " selected" : "";
    const disabled = project.service_status !== "ready" ? " disabled" : "";
    const suffix = project.service_status === "ready" ? "" : ` (${escapeHtml(project.service_status || "недоступен")})`;
    return `<option value="${escapeHtml(project.id)}"${selected}${disabled}>${escapeHtml(project.name)}${suffix}</option>`;
  }).join("");

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${panelCss()}</style></head><body><div class="bar"><a class="brand" href="https://spaces.community/account" target="_blank" rel="noopener">Spaces</a><span class="divider"></span><span class="identity"><small>Аккаунт</small><b>${escapeHtml(context.accountName || "Spaces")}</b></span><label class="project"><span>Проект</span><select id="project" aria-label="Активный проект">${projectOptions}</select></label><nav>${links}<a class="settings" href="https://spaces.community/account?project=${projectId}" target="_blank" rel="noopener">Настройки</a><a href="https://spaces.community/account" target="_blank" rel="noopener">Профиль</a></nav>${toggle}</div>${panelScript(currentService)}</body></html>`;
}

module.exports = { createPanelPage, readSignedContext };
