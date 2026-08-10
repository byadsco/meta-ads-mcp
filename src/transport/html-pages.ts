import type { ApifyTokenStatus } from "../store/apify-token-repo.js";
import type { MetaTokenSummary } from "../store/meta-token-repo.js";
import { escapeHtml } from "../utils/html.js";

/**
 * Shared by the consent page and the connections page so the two surfaces stay
 * visually identical. Moved verbatim out of http.ts; `PAGE_EXTRA_STYLES` holds
 * only what the connections page adds.
 */
export const PAGE_STYLES = `    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:1rem}
    .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;max-width:520px;width:100%}
    .user{display:flex;align-items:center;gap:0.75rem;padding-bottom:1rem;border-bottom:1px solid #2a2a2a;margin-bottom:1.5rem}
    .avatar{width:40px;height:40px;border-radius:50%;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600}
    .user-info{flex:1;min-width:0}
    .user-name{color:#fff;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .user-email{color:#888;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .logout{background:transparent;border:1px solid #333;color:#888;padding:0.4rem 0.75rem;border-radius:6px;font-size:0.8rem;cursor:pointer}
    .logout:hover{border-color:#555;color:#ccc}
    h1{font-size:1.3rem;color:#fff;margin-bottom:0.5rem}
    .subtitle{color:#888;margin-bottom:1.5rem;font-size:0.95rem}
    .client{color:#6cb4ee;font-weight:600}
    .section{margin-bottom:1.5rem}
    .section-title{color:#aaa;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem}
    .permissions{background:#111;border-radius:8px;padding:0.75rem 1rem}
    .permissions li{margin:0.3rem 0;color:#aaa;font-size:0.9rem;list-style:none}
    .token-row{display:flex;align-items:center;gap:0.5rem;padding:0.6rem 0.75rem;background:#111;border:1px solid #2a2a2a;border-radius:6px;margin-bottom:0.4rem;cursor:pointer}
    .token-row.active{border-color:#2563eb}
    .token-name{flex:1;color:#e0e0e0;font-size:0.9rem;font-weight:500}
    .token-expiry{color:#666;font-size:0.8rem}
    .badge{background:#222;color:#888;padding:0.1rem 0.4rem;border-radius:4px;font-size:0.7rem;text-transform:uppercase}
    .badge-warn{background:#3b1111;color:#fca5a5}
    .badge-bm{background:#1a2f3f;color:#6cb4ee;text-transform:none;max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .no-tokens{color:#888;background:#111;border-radius:8px;padding:1rem;text-align:center;font-size:0.9rem}
    details{background:#111;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1rem}
    details summary{cursor:pointer;color:#6cb4ee;font-size:0.9rem}
    details[open] summary{margin-bottom:0.75rem}
    details input[type="text"],details input[type="password"]{width:100%;padding:0.5rem 0.75rem;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#e0e0e0;margin-bottom:0.5rem}
    details button{padding:0.5rem 1rem;background:#333;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem}
    details button:hover{background:#444}
    button.approve,button.deny{width:100%;padding:0.75rem;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;margin-top:0.5rem}
    .approve{background:#2563eb;color:#fff}
    .approve:hover{background:#1d4ed8}
    .approve:disabled{background:#444;cursor:not-allowed}
    .deny{background:#222;color:#aaa}
    .deny:hover{background:#333}
    .inline{display:inline}`;

export const PAGE_EXTRA_STYLES = `    .page-actions{display:flex;gap:0.5rem;margin-top:0.5rem}
    .row-actions{display:flex;gap:0.4rem;align-items:center}
    .row-actions button{padding:0.3rem 0.6rem;background:#222;color:#aaa;border:1px solid #333;border-radius:5px;font-size:0.75rem;cursor:pointer}
    .row-actions button:hover{border-color:#555;color:#ddd}
    .active-mark{color:#6cb4ee;font-size:0.75rem}
    .danger{background:#2a1212;color:#fca5a5;border:1px solid #4a1f1f}
    .danger:hover{background:#3b1111}
    .hint{color:#777;font-size:0.8rem;margin-top:0.5rem}
    .hint a{color:#6cb4ee}
    .manage-link{display:inline-block;margin-top:0.5rem;color:#6cb4ee;font-size:0.85rem}`;

export const CONNECTIONS_PATH = "/auth/connections";

function formatUpdatedAt(updatedAt: number | null): string {
  if (!updatedAt) return "";
  return new Date(updatedAt * 1000).toISOString().slice(0, 10);
}

export interface ApifySectionContext {
  status: ApifyTokenStatus;
  /** Internal path the POST handlers redirect back to. Already validated by the caller. */
  returnTo: string;
  variant: "consent" | "connections";
}

/**
 * The consent variant deliberately omits the disconnect button: dropping a
 * credential mid-OAuth is a destructive action the user did not come here for.
 */
export function renderApifySection(ctx: ApifySectionContext): string {
  const returnHidden = `<input type="hidden" name="return" value="${escapeHtml(ctx.returnTo)}" />`;
  const tokenField = `<input type="password" name="apify_token" placeholder="apify_api_…" required minlength="10" maxlength="200" autocomplete="off" />`;

  const registerForm = `<form method="POST" action="/auth/register-apify-token">
        ${returnHidden}
        ${tokenField}
        <button type="submit">Validar y guardar</button>
      </form>
      <p class="hint">Consíguelo en <a href="https://console.apify.com/settings/integrations" target="_blank" rel="noopener noreferrer">console.apify.com</a>. Cuesta aprox. USD 0,75 por cada 1.000 anuncios.</p>`;

  if (!ctx.status.registered) {
    return `<div class="section">
      <div class="section-title">Apify — Ad Library (opcional)</div>
      <details>
        <summary>Conectar Apify para investigar anuncios de la competencia</summary>
        ${registerForm}
      </details>
      ${ctx.variant === "consent" ? `<p class="hint">Opcional: no hace falta para aprobar.</p>` : ""}
    </div>`;
  }

  const account = escapeHtml(ctx.status.apifyUsername ?? ctx.status.apifyUserId ?? "cuenta Apify");
  const updated = formatUpdatedAt(ctx.status.updatedAt);
  const disconnect =
    ctx.variant === "connections"
      ? `<form method="POST" action="/auth/delete-apify-token" class="inline">
          ${returnHidden}
          <button type="submit" class="danger">Desconectar</button>
        </form>`
      : "";

  return `<div class="section">
      <div class="section-title">Apify — Ad Library (opcional)</div>
      <div class="token-row">
        <span class="token-name">${account}</span>
        <span class="badge">conectado</span>
        ${updated ? `<span class="token-expiry">${updated}</span>` : ""}
        <span class="row-actions">${disconnect}</span>
      </div>
      <details>
        <summary>Reemplazar token</summary>
        ${registerForm}
      </details>
    </div>`;
}

export interface ConnectionsPageContext {
  user: { fbUserId: string; email: string | null; name: string | null };
  tokens: MetaTokenSummary[];
  activeName: string | null;
  apify: ApifyTokenStatus;
}

export function userInitials(user: { name: string | null; email: string | null }): string {
  return (user.name ?? user.email ?? "?")
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** `kind` and the day count are trusted enum/number values, so only names are escaped. */
export function describeTokenExpiry(token: MetaTokenSummary): string {
  if (token.kind === "system_user") return "no expira";
  if (!token.expiresAt) return "—";
  return `${Math.max(0, Math.ceil((token.expiresAt - Date.now() / 1000) / 86400))} días`;
}

function renderMetaTokenRows(ctx: ConnectionsPageContext): string {
  if (ctx.tokens.length === 0) {
    return `<p class="no-tokens">No hay tokens de Meta conectados. Cierra sesión y vuelve a iniciar, o registra un System User token desde la pantalla de autorización.</p>`;
  }

  return ctx.tokens
    .map((t) => {
      const isActive = t.name === ctx.activeName;
      const expired = t.isExpired ? '<span class="badge badge-warn">expirado</span>' : "";
      const businessChip = t.businessName
        ? `<span class="badge badge-bm" title="Business Manager">${escapeHtml(t.businessName)}</span>`
        : "";
      const action = isActive
        ? '<span class="active-mark">activo</span>'
        : `<form method="POST" action="/auth/select-token" class="inline">
            <input type="hidden" name="name" value="${escapeHtml(t.name)}" />
            <input type="hidden" name="return" value="${CONNECTIONS_PATH}" />
            <button type="submit">Usar</button>
          </form>`;

      return `<div class="token-row${isActive ? " active" : ""}">
        <span class="token-name">${escapeHtml(t.name)}</span>
        <span class="badge">${t.kind === "system_user" ? "system" : "personal"}</span>
        ${businessChip}
        ${expired}
        <span class="token-expiry">${describeTokenExpiry(t)}</span>
        <span class="row-actions">${action}</span>
      </div>`;
    })
    .join("\n");
}

export function renderConnectionsPage(ctx: ConnectionsPageContext): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conexiones — Meta Ads MCP</title>
  <style>
${PAGE_STYLES}
${PAGE_EXTRA_STYLES}
  </style>
</head>
<body>
  <div class="card">
    <div class="user">
      <div class="avatar">${escapeHtml(userInitials(ctx.user) || "U")}</div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(ctx.user.name ?? "Usuario Meta")}</div>
        <div class="user-email">${escapeHtml(ctx.user.email ?? ctx.user.fbUserId)}</div>
      </div>
      <form method="POST" action="/auth/logout" class="inline">
        <button type="submit" class="logout">Salir</button>
      </form>
    </div>

    <h1>Conexiones</h1>
    <p class="subtitle">Credenciales guardadas para tu cuenta. Se aplican a todos los clientes MCP que autorices.</p>

    <div class="section">
      <div class="section-title">Tokens de Meta</div>
      ${renderMetaTokenRows(ctx)}
    </div>

    ${renderApifySection({ status: ctx.apify, returnTo: CONNECTIONS_PATH, variant: "connections" })}
  </div>
</body>
</html>`;
}
