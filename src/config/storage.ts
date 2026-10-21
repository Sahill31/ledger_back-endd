import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageClient } from "@supabase/storage-js";
import { env } from "./env";
import { ApiError } from "../utils/ApiError";

/**
 * Private document storage abstraction.
 *
 * - `supabase`: objects live in a PRIVATE Supabase Storage bucket; downloads
 *   use short-lived signed URLs created with the service-role key (never sent
 *   to the frontend).
 * - `local`: objects live under LOCAL_STORAGE_DIR on the API host; downloads
 *   use HMAC-signed URLs served by `GET /files/:key(*)` on this API.
 *
 * Object storage cannot participate in Postgres transactions — callers must
 * delete the object if the surrounding DB transaction fails (orphan cleanup).
 */
export interface StorageProvider {
  upload(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Returns a short-lived URL the caller may open directly (no API auth). */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  readLocal?(key: string): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Supabase provider
// ---------------------------------------------------------------------------

class SupabaseStorageProvider implements StorageProvider {
  private client: StorageClient;
  private bucket: string;

  constructor() {
    this.client = new StorageClient(`${env.SUPABASE_URL}/storage/v1`, {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    });
    this.bucket = env.SUPABASE_STORAGE_BUCKET;
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await this.client.from(this.bucket).upload(key, body, {
      contentType,
      upsert: false,
    });
    if (error) throw ApiError.badRequest(`Document upload failed: ${error.message}`);
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const { data, error } = await this.client
      .from(this.bucket)
      .createSignedUrl(key, ttlSeconds);
    if (error || !data?.signedUrl) {
      throw ApiError.notFound("Document not found or unavailable");
    }
    return data.signedUrl;
  }

  async delete(key: string): Promise<void> {
    await this.client.from(this.bucket).remove([key]);
  }
}

// ---------------------------------------------------------------------------
// Local provider (development / self-hosted single node)
// ---------------------------------------------------------------------------

const SIGNED_URL_TTL_S = 5 * 60;

export function signLocalFileKey(key: string, expiresAtSec: number): string {
  return createHmac("sha256", env.fileUrlSecret)
    .update(`${key}:${expiresAtSec}`)
    .digest("hex");
}

export function verifyLocalFileSignature(
  key: string,
  expiresAtSec: number,
  signature: string
): boolean {
  if (expiresAtSec * 1000 < Date.now()) return false;
  const expected = signLocalFileKey(key, expiresAtSec);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

class LocalStorageProvider implements StorageProvider {
  private root: string;

  constructor() {
    this.root = path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);
  }

  private resolve(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw ApiError.badRequest("Invalid storage key");
    }
    return resolved;
  }

  async upload(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async getSignedUrl(key: string, ttlSeconds = SIGNED_URL_TTL_S): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = signLocalFileKey(key, expires);
    const base = env.PUBLIC_API_BASE_URL ?? `http://localhost:${env.PORT}`;
    return `${base}${env.API_PREFIX}/files/${encodeURIComponent(key)}?e=${expires}&s=${sig}`;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch {
      /* already gone */
    }
  }

  async readLocal(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw ApiError.notFound("Document not found");
    }
  }
}

// ---------------------------------------------------------------------------

export const storage: StorageProvider =
  env.STORAGE_PROVIDER === "supabase"
    ? new SupabaseStorageProvider()
    : new LocalStorageProvider();

/** Build a storage object key for a bill document. */
export function billDocumentKey(
  dealershipId: string,
  billId: string,
  extension: string
): string {
  return `bills/${dealershipId}/${billId}-${randomUUID().slice(0, 8)}.${extension}`;
}
