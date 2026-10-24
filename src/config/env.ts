import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),
  JWT_SECRET: z.string().default('orchestra-rfid-jwt-super-secret-key-2026'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  SMTP_HOST: z.string().default('smtp.ethereal.email'),
  SMTP_PORT: z.string().default('587'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('"ORCHESTRA Framework" <no-reply@orchestra.edu>'),
  HARDWARE_API_KEY: z.string().default('ORCHESTRA_ESP32_SECURE_TOKEN_2026'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = {
  ...parsed.data,
  PORT: parseInt(parsed.data.PORT, 10),
  SMTP_PORT: parseInt(parsed.data.SMTP_PORT, 10),
};

export default env;
