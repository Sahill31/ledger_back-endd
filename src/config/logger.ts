import { pino } from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-job-secret']",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.tokenHash",
    ],
    censor: "[redacted]",
  },
  ...(env.isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});
