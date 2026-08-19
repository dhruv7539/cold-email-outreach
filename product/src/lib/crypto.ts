import crypto from "node:crypto";

// Users hand us Apollo and LLM API keys. Those are their money, so they are
// encrypted with AES-256-GCM before they touch the database and only decrypted
// in memory for the duration of a request.
//
// APP_ENCRYPTION_KEY is 32 bytes, base64 or hex. Rotating it invalidates every
// stored key, which forces users to re-enter them; that is the intended
// behaviour for a compromised master key.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function masterKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  const key = Buffer.from(raw, raw.length === 64 ? "hex" : "base64");
  if (key.length !== 32) {
    throw new Error(`APP_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** Returns iv.tag.ciphertext, base64, colon-joined. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed ciphertext.");
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Random URL-safe token (for magic links, sessions, pairing tokens). */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** SHA-256 hex hash, for storing tokens so a DB leak is not directly replayable. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare of two hex strings. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Last 4 chars of a stored key, for display. Never returns the key itself. */
export function maskKey(encrypted?: string | null): string {
  if (!encrypted) return "";
  try {
    const plain = decrypt(encrypted);
    return plain.length <= 4 ? "····" : `····${plain.slice(-4)}`;
  } catch {
    return "····";
  }
}
