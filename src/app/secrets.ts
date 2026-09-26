import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error("Invalid token encryption key");
  return key;
}

export function sealSecret(value: string, masterKey: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(masterKey), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openSecret(value: string, masterKey: string, context: string): string {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid encrypted token");
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted token");
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(masterKey), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
}
