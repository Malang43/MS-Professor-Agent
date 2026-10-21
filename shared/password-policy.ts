// Local common/guessable-password screening. No password is sent to a third party.
// This is a conservative local blocklist, not a complete compromised-password corpus.
export function passwordStrength(
  value: string,
  email = "",
): "Weak" | "Fair" | "Strong" {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const common = [
    "password",
    "qwerty",
    "letmein",
    "welcome",
    "admin",
    "iloveyou",
    "123456",
    "changeme",
    "correcthorsebatterystaple",
  ];
  if (
    value.length < 15 ||
    !compact ||
    /^(.)\1+$/.test(compact) ||
    common.some(
      (word) =>
        compact === word || new RegExp("^" + word + "[0-9]*$").test(compact),
    ) ||
    /^(1234567890|abcdefghijklmnopqrstuvwxyz|qwertyuiop)+$/.test(compact) ||
    /^(.{1,5})\1{2,}$/.test(compact) ||
    (email &&
      compact.includes(email.split("@")[0].toLowerCase()) &&
      email.split("@")[0].length >= 4)
  )
    return "Weak";
  return value.length >= 20 && new Set(value.toLowerCase()).size >= 8
    ? "Strong"
    : "Fair";
}
