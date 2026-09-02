import 'dotenv/config';
import * as z from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string(),
  // Local docker-compose only. Not required on Vercel.
  DB_USERNAME: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_NAME: z.string().optional(),
  DB_PORT: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default(
    process.env.VERCEL ? "info" : "debug"
  )
});

export type env = z.infer<typeof envSchema>;

let envVariables: env;
try {
  envVariables = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("Missing/invalid environment variables:", error.issues);
  } else {
    console.error("Something went wrong while reading the environment variables...", error);
  }
  throw new Error("Invalid environment variables");
}

export default envVariables;
