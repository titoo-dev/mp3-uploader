import { KVNamespace } from "@cloudflare/workers-types";
import cryptojs from "crypto-js";
import { Audio, Project } from "./types";

export async function saveProject(env: KVNamespace, project: Project) {
  project.updatedAt = new Date().toISOString();
  await env.put(`project:${project.id}`, JSON.stringify(project));
}

/**
 * Find a file with the given hash in the KV store
 * @param {KVNamespace} kv - The KV namespace to search
 * @param {string} hash - File hash to search for
 * @returns {Promise<Audio|null>} - Returns file metadata if found, null otherwise
 */
export async function findFileByHash(
  kv: KVNamespace,
  hash: string
): Promise<Audio | null> {
  // List all audio files
  const { keys } = await kv.list({ prefix: "audio:" });

  // Check each file for matching hash
  for (const key of keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;

    const meta = JSON.parse(raw) as Audio;
    if (meta.fileHash === hash) {
      return meta;
    }
  }

  return null;
}


/**
 * Generate a SHA-256 hash from file content
 * @param {Uint8Array} fileContent - The file content to hash
 * @returns {Promise<string>} - Hex string of the hash
 */
export async function generateFileHash(fileContent: Uint8Array): Promise<string> {
  // Convert Uint8Array to WordArray that CryptoJS can use
  const wordArray = cryptojs.lib.WordArray.create(fileContent);

  // Generate SHA-256 hash using CryptoJS
  const hash = cryptojs.SHA256(wordArray);

  // Return the hash as a hex string
  return hash.toString(cryptojs.enc.Hex);
}

