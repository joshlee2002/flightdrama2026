// Groq Dev tier — 300,000 tokens/minute on llama-3.3-70b-versatile.
// All pipeline steps use the 70B model for maximum quality.
// Manus Forge DataAPI kept separate for Twitter/X built-in data sources.
const customApiKey = process.env.OPENAI_API_KEY_CUSTOM ?? "";
const customApiUrl = process.env.OPENAI_API_URL_CUSTOM ?? "";
const useCustomOpenAI = customApiKey.length > 0;

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "flightdrama-jwt-secret-fallback-key-2026",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",

  // ── LLM API — Groq (all writing, scoring, research synthesis) ────────────
  forgeApiUrl: useCustomOpenAI
    ? (customApiUrl || "https://api.openai.com/v1")
    : (process.env.BUILT_IN_FORGE_API_URL ?? ""),
  forgeApiKey: useCustomOpenAI
    ? customApiKey
    : (process.env.BUILT_IN_FORGE_API_KEY ?? ""),

  // Use llama-3.3-70b-versatile for everything — Dev tier gives 300k TPM
  defaultLlmModel: useCustomOpenAI
    ? (customApiUrl.includes("groq.com") ? "llama-3.3-70b-versatile" : "gpt-4o-mini")
    : "",

  // Same model for headlines (no need to split now)
  headlineModel: useCustomOpenAI && customApiUrl.includes("groq.com")
    ? "llama-3.3-70b-versatile"
    : "",

  // ── Manus Forge DataAPI — ALWAYS Manus built-in, never replaced by Groq ──
  // callDataApi() uses this for Twitter/X data, built-in search APIs, etc.
  dataApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  dataApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",

  // Instagram
  instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN ?? "",
  appPassword: process.env.APP_PASSWORD ?? "",
};
