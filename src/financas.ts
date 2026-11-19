import fs from "node:fs";
import path from "node:path";
import type { FileNote } from "./shared/types.js";

export function readNote(dir: string | null, filename: string): FileNote | null {
  if (!dir) return null;
  const full = path.resolve(dir, filename);
  const root = path.resolve(dir);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  try {
    const stat = fs.statSync(full);
    const content = fs.readFileSync(full, "utf8").slice(0, 20_000);
    return { name: filename, path: full, updatedAt: stat.mtimeMs, content, missing: false };
  } catch {
    return { name: filename, path: full, updatedAt: 0, content: "", missing: true };
  }
}

export function writeDeskFile(dir: string | null, filename: string, content: string): void {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const full = path.resolve(dir, filename);
  const tmp = `${full}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, full);
}

export function manualBlock(note: FileNote | null): boolean {
  if (!note || note.missing) return false;
  return /MESA:\s*BLOQUEAR/i.test(note.content);
}

export function bulletLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 8)
    .slice(0, 20);
}
