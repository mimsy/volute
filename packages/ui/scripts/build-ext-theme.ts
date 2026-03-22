import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const fontImport = `@import url("https://fonts.googleapis.com/css2?family=Averia+Serif+Libre:wght@300;400;700&family=Fira+Code:wght@300;400;500;600&family=Averia+Sans+Libre:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap");\n`;
const theme = readFileSync(resolve(root, "src/theme.css"), "utf-8");
const base = readFileSync(resolve(root, "src/base.css"), "utf-8");

const output = `/* Auto-generated from @volute/ui — do not edit */\n${fontImport}\n${theme}\n${base}`;

mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/ext-theme.css"), output);
console.log("Generated dist/ext-theme.css");
