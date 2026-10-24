import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CLIENT_ORIGINS: z.string().default("http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost"),
  API_HOST: z.string().default("127.0.0.1"),
  LAN_ENABLED: z.enum(["true","false"]).default("false"),
  TRUST_PROXY: z.string().default(""),
  SERVER_MODE:z.enum(["lan","cloud"]).default("lan"),
  PUBLIC_API_URL:z.string().url().optional(),
});

export const env = envSchema.parse(process.env);
export const clientOrigins = env.CLIENT_ORIGINS.split(",").map((origin) => origin.trim());

