import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { expandHome, readJson, writeJson } from "./gmail-api.mjs";

export const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_SETTINGS_BASIC_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";

export function getDefaultSheetsOauthPaths(overrides = {}) {
  return {
    oauthPath: expandHome(
      overrides.oauthPath ?? process.env.GOOGLE_OAUTH_PATH ?? "~/.gmail-mcp/gcp-oauth.keys.json"
    ),
    credentialsPath: expandHome(
      overrides.credentialsPath ??
        process.env.GOOGLE_SHEETS_CREDENTIALS_PATH ??
        "~/.gmail-mcp/sheets.credentials.json"
    ),
  };
}

export async function getOauthClient(oauthPath) {
  const oauthJson = await readJson(oauthPath);
  const oauthClient = oauthJson.installed ?? oauthJson.web;

  if (!oauthClient?.client_id || !oauthClient?.client_secret || !oauthClient?.auth_uri || !oauthClient?.token_uri) {
    throw new Error(`OAuth client file is missing expected keys: ${oauthPath}`);
  }

  return oauthClient;
}

export async function buildGoogleAuthUrl({
  oauthPath,
  redirectUri,
  scopes,
  state,
  accessType = "offline",
  includeGrantedScopes = true,
  prompt = "consent",
}) {
  const oauthClient = await getOauthClient(oauthPath);

  const url = new URL(oauthClient.auth_uri);
  url.searchParams.set("client_id", oauthClient.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", accessType);
  if (includeGrantedScopes) {
    url.searchParams.set("include_granted_scopes", "true");
  }
  if (prompt) {
    url.searchParams.set("prompt", prompt);
  }
  if (state) {
    url.searchParams.set("state", state);
  }

  return url.toString();
}

export async function exchangeAuthCode({
  oauthPath,
  credentialsPath,
  code,
  redirectUri,
}) {
  const oauthClient = await getOauthClient(oauthPath);

  const body = new URLSearchParams({
    client_id: oauthClient.client_id,
    client_secret: oauthClient.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch(oauthClient.token_uri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: ${response.status} ${await response.text()}`);
  }

  const token = await response.json();
  const credentials = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    token_type: token.token_type ?? "Bearer",
    expiry_date: Date.now() + (token.expires_in ?? 3600) * 1000,
  };

  await writeJson(credentialsPath, credentials);
  return credentials;
}

export async function authorizeWithLocalServer({
  oauthPath,
  credentialsPath,
  scopes,
  port = 3000,
  host = "127.0.0.1",
  openCommand = false,
}) {
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `http://${host}:${port}/oauth2callback`;
  const authUrl = await buildGoogleAuthUrl({
    oauthPath,
    redirectUri,
    scopes,
    state,
  });
  return await new Promise(async (resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(failTimer);
      server.close();
      fn(value);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", redirectUri);
        if (requestUrl.pathname !== "/oauth2callback") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        if (requestUrl.searchParams.get("state") !== state) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("State mismatch");
          finish(reject, new Error("OAuth state mismatch."));
          return;
        }

        const code = requestUrl.searchParams.get("code");
        const error = requestUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Authorization failed: ${error}`);
          finish(reject, new Error(`OAuth authorization failed: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Missing code");
          finish(reject, new Error("OAuth callback missing code."));
          return;
        }

        const credentials = await exchangeAuthCode({
          oauthPath,
          credentialsPath,
          code,
          redirectUri,
        });

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>Sheets authorization complete</h1><p>You can close this tab.</p></body></html>");
        finish(resolve, { authUrl, redirectUri, credentials });
      } catch (error) {
        finish(reject, error);
      }
    });

    server.on("error", (error) => finish(reject, error));

    const failTimer = setTimeout(() => {
      finish(reject, new Error("Timed out waiting for OAuth callback."));
    }, 10 * 60 * 1000);

    server.listen(port, host, async () => {
      console.error(`AUTH_URL ${authUrl}`);
      console.error(`REDIRECT_URI ${redirectUri}`);
      if (openCommand) {
        const { spawn } = await import("node:child_process");
        spawn("open", [authUrl], { stdio: "ignore", detached: true }).unref();
      }
    });
  });
}
