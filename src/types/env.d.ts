interface Env {
  GEMINI_API_KEY: string;
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  MOCHA_USERS_SERVICE_API_URL: string;
  MOCHA_USERS_SERVICE_API_KEY: string;

  // LLM provider configuration
  LLM_PROVIDER?: "google" | "openai";
  OPENAI_API_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  LLM_MODEL?: string;
}
