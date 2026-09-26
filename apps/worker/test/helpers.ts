import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";

export const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const readFixture = async (name: string) =>
  new Uint8Array(await readFile(fixturePath(name)));

export async function fixturePages(name: string): Promise<string[]> {
  const pdf = await getDocumentProxy(await readFixture(name));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}
