// Per-room encryption. Each room has a random 256-bit key that is never stored in the clear: every
// member's access secret (and every pending invite code) gets its own AES-GCM-wrapped copy, so the
// stored room is ciphertext unless someone presents a valid link. The key lives only in memory
// while the room is serving requests.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

const SALT = "agent-board/v1";
const PREFIX = "e1:";

export const newRoomKey = (): Buffer => randomBytes(32);

export const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

// Separate from the SHA-256 hash used for login, so the stored hash can't be used to unwrap anything.
export const kek = (secret: string, purpose: "member" | "invite"): Buffer =>
  Buffer.from(hkdfSync("sha256", secret, SALT, purpose, 32));

export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function open(key: Buffer, sealed: string): string {
  const buf = Buffer.from(sealed.slice(PREFIX.length), "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export const isSealed = (v: string): boolean => v.startsWith(PREFIX);

export const wrapKey = (wrapping: Buffer, roomKey: Buffer): string => seal(wrapping, roomKey.toString("base64"));

export const unwrapKey = (wrapping: Buffer, wrapped: string): Buffer => Buffer.from(open(wrapping, wrapped), "base64");
