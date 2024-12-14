import { pino } from "pino";

export default class Logger {
  static shared() {
    if (!this._instance) {
      this._instance = new Logger();
    }
    return this._instance;
  }

  constructor() {
    this._pino = pino({
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV !== "production"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
              },
            }
          : undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }

  info(object, message = undefined) {
    this._pino.info(object, message);
  }
}
