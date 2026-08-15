import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query, queryOne } from "./db";
import { generateToken, hashToken } from "./crypto";
import { findOrCreateUser, getUserById, type User } from "./repo";

// Passwordless auth. A magic link mints a short-lived login token; redeeming it
// creates a session. Both tokens are stored hashed, so a database leak yields no
// usable credential.

const SESSION_COOKIE = "outreach_session";
const LOGIN_TOKEN_TTL_MS = 20 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createLoginToken(email: string): Promise<{ token: string }> {
  const user = await findOrCreateUser(email);
  const token = generateToken();
  await query(
    "INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(token), user.id, new Date(Date.now() + LOGIN_TOKEN_TTL_MS)]
  );
  return { token };
}

export async function redeemLoginToken(token: string): Promise<User | null> {
  const row = await queryOne<{ user_id: string; expires_at: Date; used_at: Date | null }>(
    "SELECT user_id, expires_at, used_at FROM login_tokens WHERE token_hash = $1",
    [hashToken(token)]
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;

  await query("UPDATE login_tokens SET used_at = now() WHERE token_hash = $1", [hashToken(token)]);
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.user_id]);

  const sessionToken = generateToken();
  await query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(sessionToken), row.user_id, new Date(Date.now() + SESSION_TTL_MS)]
  );

  const store = await cookies();
  store.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });

  return getUserById(row.user_id);
}

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = await queryOne<{ user_id: string; expires_at: Date }>(
    "SELECT user_id, expires_at FROM sessions WHERE token_hash = $1",
    [hashToken(token)]
  );
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return getUserById(row.user_id);
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  return user;
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  store.delete(SESSION_COOKIE);
}
