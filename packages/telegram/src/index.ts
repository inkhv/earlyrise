import fs from "node:fs/promises";
import path from "node:path";

export async function telegramGetFile(botToken: string, fileId: string): Promise<{ file_path: string }> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const json: any = await res.json();
  if (!json?.ok) throw new Error(`getFile failed: ${JSON.stringify(json)}`);
  return json.result as { file_path: string };
}

export async function telegramDownloadFileToPath(
  botToken: string,
  filePath: string,
  outPath: string
): Promise<void> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
}






