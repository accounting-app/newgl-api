import type { MiddlewareHandler } from "hono";

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};
const useColor = !process.env.NO_COLOR;

function colorize(text: string, color: string) {
  return useColor ? `${color}${text}${colors.reset}` : text;
}

function colorStatus(status: number) {
  if (status >= 500) return colorize(String(status), colors.red);
  if (status >= 400) return colorize(String(status), colors.yellow);
  if (status >= 300) return colorize(String(status), colors.cyan);
  return colorize(String(status), colors.green);
}

function getClientIp(context: Parameters<MiddlewareHandler>[0]) {
  // Fly / reverse proxies
  const forwarded = context.req.header("fly-client-ip")
    ?? context.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? context.req.header("x-real-ip");
  if (forwarded) return forwarded;
  const server = context.env?.server ;
  return server?.requestIP(context.req.raw)?.address ?? "-";
}

export function requestLogger(): MiddlewareHandler {
  return async (context, next) => {
    const start = Date.now();
    const method = context.req.method;
    const path = context.req.path; // or new URL(c.req.url).pathname + search
    await next();
    const ms = Date.now() - start;
    const status = context.res.status;
    const ip = getClientIp(context);
    const timestamp = new Date().toISOString();
    const line = [
      colorize(timestamp, colors.dim),
      colorize(ip, colors.cyan),
      colorize(method, colors.magenta),
      path,
      colorStatus(status),
      `${ms}ms`,
    ].join(" ");
    console.log(line);
  };
}