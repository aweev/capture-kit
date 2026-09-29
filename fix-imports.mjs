import { readFile, writeFile } from "node:fs/promises";

let content = await readFile("src/discover.ts", "utf8");
content = content
  .replace("import { readFile } from 'node:fs/promises';\n", "")
  .replace("import path from 'node:path';\n", "")
  .replace("import fg from 'fast-glob';\n", "")
  .replace("import type { ResolvedConfig } from './config.ts';\n", "")
  .replace("import { pageSlug } from './jobs.ts';\n", "");
await writeFile("src/discover.ts", content);
console.log("Fixed");