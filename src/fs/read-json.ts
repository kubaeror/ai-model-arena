import { promises as fsp } from 'node:fs';

/** Read + JSON.parse a file, returning null when it is missing or malformed. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}
