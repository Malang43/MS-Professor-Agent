import { HttpError } from "./runtime";
import { passwordStrength } from "../../../shared/password-policy";
export async function passwordHash(
  password: string,
  salt = crypto.randomUUID(),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return (
    salt +
    ":" +
    Array.from(new Uint8Array(bits), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}

export function equalHash(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export function validPassword(password: string, email = "") {
  if (
    password.length < 15 ||
    password.length > 128 ||
    passwordStrength(password, email) === "Weak"
  )
    throw new HttpError(
      400,
      "Use 15–128 characters and avoid common, repeated or easily guessed passwords. A unique passphrase is welcome.",
    );
}
