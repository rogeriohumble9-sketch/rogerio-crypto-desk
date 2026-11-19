import type { DeskDb } from "./db.js";
import type { LogView } from "./shared/types.js";

export class Logger {
  readonly lines: LogView[] = [];

  constructor(private readonly db: DeskDb) {}

  info(scope: string, message: string): void {
    this.write("info", scope, message);
  }

  warn(scope: string, message: string): void {
    this.write("warn", scope, message);
  }

  error(scope: string, message: string): void {
    this.write("error", scope, message);
  }

  private write(level: string, scope: string, message: string): void {
    const line = { ts: Date.now(), level, scope, message };
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.shift();
    const text = `[${new Date(line.ts).toISOString()}] ${level.toUpperCase()} ${scope} ${message}`;
    if (level === "error") console.error(text);
    else console.log(text);
    try {
      this.db.insertLog(line);
    } catch {
      /* o log em disco não pode derrubar a mesa */
    }
  }
}
