// Refuse content that looks like a credential, so an agent can't leak one onto the board by accident or on request.
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "OpenAI-style API key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/ },
  { label: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "Stripe live key", re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/ },
  { label: "SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { label: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: "Slack webhook", re: /hooks\.slack\.com\/services\/[A-Za-z0-9\/]{20,}/ },
  { label: "Stripe key", re: /\b(sk|rk)_test_[A-Za-z0-9]{20,}/ },
  // "the password is hunter2-Xq9!", "pwd: s3cret!": a value with a digit or symbol, so "password is required" passes.
  {
    label: "password in text",
    re: /\b(pass(word|wd|phrase)?|pwd|passcode|pin)\b\s*(is|was|=|:|->)\s*["'`]?(?=[^\s"'`]*[\d!@#$%^&*?_~-])[^\s"'`]{6,}/i,
  },
  { label: "agent-board access token", re: /\/r\/[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}/ },
  { label: "connection string with password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{6,}@[^\s]+/i },
  {
    label: ".env-style secret",
    re: /^\s*(export\s+)?[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*['"]?[^\s'"#]{8,}/m,
  },
];

export function findSecret(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const { label, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split("\n").length;
      return `${label} (line ${line})`;
    }
  }
  return null;
}
