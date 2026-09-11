import { appendFile, readFile, writeFile } from 'node:fs/promises';

export async function readText(file) {
  return readFile(file, 'utf8');
}

export async function writeText(file, content) {
  await writeFile(file, content, 'utf8');
}

export async function appendText(file, content) {
  await appendFile(file, content, 'utf8');
}
