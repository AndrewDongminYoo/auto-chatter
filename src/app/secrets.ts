import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// The token encryption keys (#61). `current` seals every new secret. `previous` only opens the secrets that were
// sealed before a key rotation, until the token_key_rewrap cron step has sealed them again with `current`.
// A plain string is a ring that holds only the current key.
export interface TokenKeys {
  current: string;
  previous?: string | undefined;
}
export type SecretKey = string | TokenKeys;

interface RingKey {
  id: string;
  key: Buffer;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error("Invalid token encryption key");
  return key;
}

// A short identifier of a key, written in each v2 envelope so that SQL can find the secrets sealed with another
// key. It is an HMAC of a fixed label under the key, so it tells nothing about the key itself.
function keyId(key: Buffer): string {
  return createHmac("sha256", key).update("auto-chatter token key id").digest().subarray(0, 8).toString("base64url");
}

// Decodes every key of the ring, so an invalid previous key fails as early as an invalid current key.
function ring(keys: SecretKey): RingKey[] {
  const values = typeof keys === "string" ? [keys] : [keys.current, ...(keys.previous ? [keys.previous] : [])];
  return values.map((value) => {
    const key = decodeKey(value);
    return { id: keyId(key), key };
  });
}

// The ring from the Worker or Node environment, or undefined when no current key is set. An empty previous key
// counts as unset.
export function tokenKeys(env: { TOKEN_ENCRYPTION_KEY?: string | undefined; TOKEN_ENCRYPTION_KEY_PREVIOUS?: string | undefined }): TokenKeys | undefined {
  if (!env.TOKEN_ENCRYPTION_KEY) return undefined;
  return { current: env.TOKEN_ENCRYPTION_KEY, previous: env.TOKEN_ENCRYPTION_KEY_PREVIOUS || undefined };
}

// The prefix of every envelope sealed with the current key. A stored secret without it must be sealed again
// before the previous key is removed.
export function currentKeyPrefix(keys: SecretKey): string {
  return `v2.${ring(keys)[0]!.id}.`;
}

export function sealSecret(value: string, keys: SecretKey, context: string): string {
  const { id, key } = ring(keys)[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v2", id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: string, context: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

// Opens a v2 envelope with the ring key that its identifier names, and a v1 envelope (sealed before #61, with no
// identifier) with each ring key in turn; the GCM tag rejects every key but the one that sealed it.
export function openSecret(value: string, keys: SecretKey, context: string): string {
  const keyring = ring(keys);
  const parts = value.split(".");
  const versioned = parts.length === 5 && parts[0] === "v2";
  if (!versioned && (parts.length !== 4 || parts[0] !== "v1")) throw new Error("Invalid encrypted token");
  const [ivText, tagText, ciphertext] = versioned ? parts.slice(2) : parts.slice(1);
  const iv = Buffer.from(ivText!, "base64url");
  const tag = Buffer.from(tagText!, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted token");
  if (versioned) {
    const match = keyring.find((entry) => entry.id === parts[1]);
    if (!match) throw new Error("Unknown token encryption key");
    return open(match.key, iv, tag, ciphertext!, context);
  }
  let failure: unknown;
  for (const { key } of keyring)
    try {
      return open(key, iv, tag, ciphertext!, context);
    } catch (error) {
      failure = error;
    }
  throw failure;
}
