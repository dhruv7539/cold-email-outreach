import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

export function expandHome(filePath) {
  if (!filePath) {
    return filePath;
  }

  return filePath.startsWith("~/")
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function loadSpec(specPath) {
  const moduleUrl = pathToFileURL(path.resolve(specPath)).href;
  const specModule = await import(moduleUrl);
  const spec = specModule.default;

  if (!spec || !Array.isArray(spec.drafts) || spec.drafts.length === 0) {
    throw new Error("Spec must export a default object with a non-empty drafts array.");
  }

  return spec;
}

export async function getAccessToken(oauthPath, credentialsPath) {
  const oauthJson = await readJson(oauthPath);
  const oauthClient = oauthJson.installed ?? oauthJson.web;
  const credentials = await readJson(credentialsPath);

  if (!oauthClient?.client_id || !oauthClient?.client_secret || !oauthClient?.token_uri) {
    throw new Error(`OAuth client file is missing expected keys: ${oauthPath}`);
  }

  if (!credentials.refresh_token) {
    throw new Error(`Credentials file is missing refresh_token: ${credentialsPath}`);
  }

  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  if (credentials.access_token && credentials.expiry_date && credentials.expiry_date > fiveMinutesFromNow) {
    return credentials.access_token;
  }

  const body = new URLSearchParams({
    client_id: oauthClient.client_id,
    client_secret: oauthClient.client_secret,
    refresh_token: credentials.refresh_token,
    grant_type: "refresh_token",
  });

  const refreshResponse = await fetch(oauthClient.token_uri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!refreshResponse.ok) {
    throw new Error(`Token refresh failed: ${refreshResponse.status} ${await refreshResponse.text()}`);
  }

  const refreshed = await refreshResponse.json();
  const nextCredentials = {
    ...credentials,
    access_token: refreshed.access_token,
    expiry_date: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    scope: refreshed.scope ?? credentials.scope,
    token_type: refreshed.token_type ?? credentials.token_type ?? "Bearer",
  };

  await writeJson(credentialsPath, nextCredentials);
  return nextCredentials.access_token;
}

export function getDefaultOauthPaths(overrides = {}) {
  return {
    oauthPath: expandHome(
      overrides.oauthPath ?? process.env.GMAIL_OAUTH_PATH ?? "~/.gmail-mcp/gcp-oauth.keys.json"
    ),
    credentialsPath: expandHome(
      overrides.credentialsPath ?? process.env.GMAIL_CREDENTIALS_PATH ?? "~/.gmail-mcp/credentials.json"
    ),
  };
}

export function toBase64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function wrapBase64(base64Value) {
  return base64Value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    return "application/pdf";
  }

  if (ext === ".txt") {
    return "text/plain";
  }

  if (ext === ".html" || ext === ".htm") {
    return "text/html";
  }

  return "application/octet-stream";
}

function normalizeHeaderValue(value) {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.filter(Boolean).join(" ");
  }

  return String(value).trim() || null;
}

export async function buildRawMessage(messageSpec, defaultAttachmentPath) {
  const boundary = `codex_boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const attachmentPath = expandHome(messageSpec.attachmentPath ?? defaultAttachmentPath);
  const html = messageSpec.html?.trim();
  const text = messageSpec.text?.trim();

  if (!messageSpec.to) {
    throw new Error("Message spec must include a recipient in `to`.");
  }

  if (!messageSpec.subject) {
    throw new Error("Message spec must include a `subject`.");
  }

  if (!html && !text) {
    throw new Error("Message spec must include either `html` or `text`.");
  }

  const lines = [
    `To: ${messageSpec.to}`,
    `Subject: ${messageSpec.subject}`,
    "MIME-Version: 1.0",
  ];

  if (messageSpec.cc) {
    lines.push(`Cc: ${messageSpec.cc}`);
  }

  if (messageSpec.bcc) {
    lines.push(`Bcc: ${messageSpec.bcc}`);
  }

  const inReplyTo = normalizeHeaderValue(messageSpec.inReplyTo);
  const references = normalizeHeaderValue(messageSpec.references);

  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
  }

  if (references) {
    lines.push(`References: ${references}`);
  }

  if (attachmentPath) {
    const attachment = await fs.readFile(attachmentPath);
    const filename = messageSpec.attachmentFilename ?? path.basename(attachmentPath);

    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${html ? 'text/html; charset="UTF-8"' : 'text/plain; charset="UTF-8"'}`);
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(html ?? text);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${getContentType(attachmentPath)}; name="${filename}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: attachment; filename="${filename}"`);
    lines.push("");
    lines.push(wrapBase64(attachment.toString("base64")));
    lines.push(`--${boundary}--`);
  } else {
    lines.push(`Content-Type: ${html ? 'text/html; charset="UTF-8"' : 'text/plain; charset="UTF-8"'}`);
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(html ?? text);
  }

  return toBase64Url(Buffer.from(lines.join("\r\n"), "utf8"));
}

async function gmailApiRequest(accessToken, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Gmail API request failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export async function createDraft(accessToken, raw, threadId) {
  return gmailApiRequest(accessToken, "drafts", {
    method: "POST",
    body: {
      message: {
        raw,
        ...(threadId ? { threadId } : {}),
      },
    },
  });
}

export async function sendMessage(accessToken, raw, threadId) {
  return gmailApiRequest(accessToken, "messages/send", {
    method: "POST",
    body: {
      raw,
      ...(threadId ? { threadId } : {}),
    },
  });
}

export async function getDraft(accessToken, draftId, format = "full") {
  return gmailApiRequest(accessToken, `drafts/${draftId}?format=${encodeURIComponent(format)}`);
}

export async function getMessage(accessToken, messageId, format = "full") {
  return gmailApiRequest(accessToken, `messages/${messageId}?format=${encodeURIComponent(format)}`);
}

export async function getThread(accessToken, threadId, format = "full") {
  return gmailApiRequest(accessToken, `threads/${threadId}?format=${encodeURIComponent(format)}`);
}

export function getHeader(headers = [], name) {
  const header = headers.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}
