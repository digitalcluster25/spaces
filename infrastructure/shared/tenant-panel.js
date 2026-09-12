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
  return `*{box-sizing:border-box}html,body{margin:0;height:44px;overflow:hidden;background:#fff;color:#18181b;font:12px ui-sans-serif,system-ui,-apple-system,sans-serif}.bar{height:44px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid #e4e4e7;white-space:nowrap}.brand{font-weight:750;font-size:13px}.divider{width:1px;height:20px;background:#e4e4e7}.identity{display:grid;line-height:1.15;max-width:220px}.identity small,.muted{color:#71717a;font-size:9px;text-transform:uppercase}.identity b{overflow:hidden;text-overflow:ellipsis}.bar nav{display:flex;align-items:center;justify-content:flex-end;gap:3px;margin-left:auto}.bar nav a,.current{padding:7px 9px;border-radius:5px;text-decoration:none;color:#18181b;font-weight:650}.bar nav a:hover{background:#f4f4f5}.current{background:#18181b;color:#fff}#toggle{width:28px;height:28px;border:1px solid #e4e4e7;border-radius:5px;background:#fff;cursor:pointer}.collapsed .bar{height:12px;justify-content:flex-end;padding:0}.collapsed .bar>*:not(#toggle){display:none}.collapsed #toggle{width:34px;height:12px;border-width:0 0 0 1px;border-radius:0;font-size:10px;line-height:10px}@media(max-width:700px){.identity:first-of-type{display:none}.bar{gap:7px;padding:0 8px}.bar nav a,.current{padding:7px 6px}}`;
}

function panelScript() {
  return `<script>const key="spaces:tenant-panel-collapsed";const button=document.getElementById("toggle");const apply=(value)=>{document.documentElement.classList.toggle("collapsed",value);button.textContent=value?"⌄":"⌃";parent.postMessage({type:"spaces-tenant-height",height:value?12:44},location.origin);localStorage.setItem(key,value?"1":"0")};button.onclick=()=>apply(localStorage.getItem(key)!=="1");apply(localStorage.getItem(key)==="1");</script>`;
}

function createPanelPage(context, currentService) {
  const toggle = `<button id="toggle" title="Свернуть панель" aria-label="Свернуть панель">⌃</button>`;
  if (!context) {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${panelCss()}</style></head><body><div class="bar"><a class="brand" href="https://spaces.community/account" target="_blank" rel="noopener">Spaces</a><span class="muted">Откройте сервис из аккаунта Spaces</span>${toggle}</div>${panelScript()}</body></html>`;
  }

  const projectId = encodeURIComponent(context.projectId);
  const services = Array.isArray(context.services) ? context.services : [];
  const links = services.map((service) => {
    const slug = escapeHtml(service.slug);
    const name = escapeHtml(service.name);
    return service.slug === currentService
      ? `<strong class="current">${name}</strong>`
      : `<a href="https://spaces.community/launch?project=${projectId}&service=${slug}" target="_blank" rel="noopener">${name}</a>`;
  }).join("");

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${panelCss()}</style></head><body><div class="bar"><a class="brand" href="https://spaces.community/account" target="_blank" rel="noopener">Spaces</a><span class="divider"></span><span class="identity"><small>Аккаунт</small><b>${escapeHtml(context.accountName || "Spaces")}</b></span><span class="identity"><small>Проект</small><b>${escapeHtml(context.projectName)}</b></span><nav>${links}<a href="https://spaces.community/account" target="_blank" rel="noopener">Профиль</a></nav>${toggle}</div>${panelScript()}</body></html>`;
}

module.exports = { createPanelPage, readSignedContext };
