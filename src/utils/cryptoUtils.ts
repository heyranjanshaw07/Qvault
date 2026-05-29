/**
 * @file cryptoUtils.ts
 * @description Client-side Visual Cryptography (Q-VC) utilities for Qvault.
 *
 * ARCHITECTURE (Visual Cryptography Controlled Links - Q-VC):
 * ─────────────────────────────────────────────────────────────
 *  Qvault uses a (2,2) XOR Secret Sharing scheme to secure documents:
 *    1. A fresh 256-bit AES-GCM key (K) is generated locally.
 *    2. The document is encrypted with K using AES-256-GCM.
 *    3. K is split mathematically into two 256-bit shares (S1, S2):
 *         S1 = Cryptographically secure random 256-bit value (Share 1)
 *         S2 = K ⊕ S1 (Share 2)
 *
 *  DISTRIBUTION:
 *    - Share 1 (S1) is Base64url-encoded and placed in the URL hash fragment.
 *      (Per RFC 3986 §3.5, fragments are never sent to any server)
 *    - Share 2 (S2) is formatted as a bytes32 hex string and stored in the
 *      smart contract (or localStorage simulator) linked to the IPFS CID.
 *
 *  DECRYPTION FLOW:
 *    - The viewer retrieves S1 from the URL hash fragment.
 *      The browser fetches S2 from the smart contract (if and only if access
 *      conditions are met, e.g. views remaining, not expired, not revoked).
 *    - S1 and S2 are XOR-recombined to reconstruct K inside RAM:
 *         K = S1 ⊕ S2
 *    - The document is decrypted locally using K and rendered in the browser.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** AES-GCM nonce/IV length: 96 bits per NIST SP 800-38D recommendation */
const AES_IV_BYTES = 12;

// ─────────────────────────────────────────────────────────────────────────────
// INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

export interface EncryptionResult {
  /** AES-GCM encrypted file bytes with IV prepended */
  encryptedBlob: Uint8Array;
  /** Base64url-encoded Share 1 (goes into the URL fragment) */
  share1: string;
  /** 32-byte hexadecimal string starting with '0x' (goes to the smart contract) */
  share2: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE ARRAY BUFFER HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copies a Uint8Array into a guaranteed plain ArrayBuffer.
 * This prevents TypeScript errors from Uint8Array<SharedArrayBuffer> vs
 * Uint8Array<ArrayBuffer> mismatches in WebCrypto API calls.
 */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(u8.byteLength);
  new Uint8Array(copy).set(u8);
  return copy;
}

// ─────────────────────────────────────────────────────────────────────────────
// BASE64URL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode Uint8Array to URL-safe Base64 (no padding).
 * URL-safe variant replaces +/= with -/_ to be safe in URL fragments.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode URL-safe Base64 string to Uint8Array.
 */
export function fromBase64(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded   = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary   = atob(padded);
  const bytes    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// XOR SECRET SHARING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits a 256-bit AES file key into two 256-bit shares using a (2,2) XOR Secret Sharing scheme.
 * Both shares are mathematically indistinguishable from random noise alone.
 */
export function splitKey(key: Uint8Array): { share1: Uint8Array; share2: Uint8Array } {
  if (key.length !== 32) {
    throw new Error(`Key must be exactly 256 bits (32 bytes), got ${key.length} bytes.`);
  }
  const share1 = crypto.getRandomValues(new Uint8Array(32));
  const share2 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    share2[i] = key[i] ^ share1[i];
  }
  return { share1, share2 };
}

/**
 * Reconstructs a 256-bit AES file key from two 256-bit shares.
 */
export function reconstructKey(share1: Uint8Array, share2: Uint8Array): Uint8Array {
  if (share1.length !== 32 || share2.length !== 32) {
    throw new Error("Both shares must be exactly 256 bits (32 bytes).");
  }
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    key[i] = share1[i] ^ share2[i];
  }
  return key;
}

/**
 * Converts a Uint8Array into a 32-byte hexadecimal string starting with '0x' for Solidity.
 */
export function bytesToBytes32(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new Error("Bytes array must be exactly 32 bytes.");
  }
  return "0x" + Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Converts a 32-byte hex string (with or without '0x' prefix) into a Uint8Array.
 */
export function bytes32ToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length !== 64) {
    throw new Error(`Invalid bytes32 hex length: expected 64 chars, got ${clean.length}.`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENCRYPTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encrypts a file using client-side AES-256-GCM, then splits the key using Q-VC.
 *
 * @param fileBytes  Raw bytes of the document to encrypt
 * @returns          EncryptionResult containing the encrypted blob, share1, and share2
 */
export async function encryptFile(fileBytes: Uint8Array): Promise<EncryptionResult> {
  console.log("[Qvault Q-VC] Starting zero-knowledge key split encryption...");

  // ── 1. Generate fresh AES-256-GCM file encryption key ─────────────────────
  const aesFileKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable required to export raw key bytes
    ["encrypt", "decrypt"]
  );

  // Export the raw key bytes (32 bytes)
  const rawKeyBuffer = await crypto.subtle.exportKey("raw", aesFileKey);
  const rawKeyBytes = new Uint8Array(rawKeyBuffer);

  // ── 2. Encrypt the file with AES-256-GCM ──────────────────────────────────
  const fileIv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const encBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: fileIv },
    aesFileKey,
    toArrayBuffer(fileBytes)
  );

  // Pack: [fileIV (12 bytes)] ‖ [encrypted ciphertext]
  const encryptedBlob = new Uint8Array(AES_IV_BYTES + encBuffer.byteLength);
  encryptedBlob.set(fileIv, 0);
  encryptedBlob.set(new Uint8Array(encBuffer), AES_IV_BYTES);

  // ── 3. Split the key using Q-VC ──────────────────────────────────────────
  const { share1, share2 } = splitKey(rawKeyBytes);

  console.log("[Qvault Q-VC] Key successfully split into two 256-bit shares.");

  return {
    encryptedBlob,
    share1: toBase64(share1),
    share2: bytesToBytes32(share2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DECRYPTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decrypts a file using Share 1 (from URL hash) and Share 2 (from smart contract).
 *
 * @param encryptedBlob  AES-GCM ciphertext (IV prepended) fetched from IPFS
 * @param share1B64      Base64url-encoded Share 1 from URL fragment
 * @param share2Hex      Solidity bytes32 hex string representing Share 2 from smart contract
 * @returns              Original plaintext file bytes
 */
export async function decryptFile(
  encryptedBlob: Uint8Array,
  share1B64: string,
  share2Hex: string
): Promise<Uint8Array> {
  console.log("[Qvault Q-VC] Reconstructing AES key from Q-VC shares...");

  // ── 1. Decode Share 1 and Share 2 ─────────────────────────────────────────
  const share1 = fromBase64(share1B64);
  const share2 = bytes32ToBytes(share2Hex);

  // ── 2. Reconstruct the AES key ────────────────────────────────────────────
  const rawKeyBytes = reconstructKey(share1, share2);

  // ── 3. Import key back into WebCrypto ─────────────────────────────────────
  const aesFileKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(rawKeyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // ── 4. Decrypt the file blob ───────────────────────────────────────────────
  const fileIv     = encryptedBlob.slice(0, AES_IV_BYTES);
  const cipherData = encryptedBlob.slice(AES_IV_BYTES);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fileIv },
    aesFileKey,
    toArrayBuffer(cipherData)
  );

  console.log("[Qvault Q-VC] Document decrypted successfully.");
  return new Uint8Array(plainBuffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Q-LINK BUILDER & PARSER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constructs the shareable Q-Link URL containing Share 1 (and optionally Share 2 as a fallback for demo mode) in the hash.
 */
export function buildQLink(
  cid: string,
  share1: string,
  share2?: string,
  maxViews?: number,
  expiryHours?: number,
  baseUrl?: string
): string {
  const origin = baseUrl ?? window.location.origin;
  let hash = share1;
  if (share2) {
    hash += `.${share2}`;
    if (maxViews !== undefined && expiryHours !== undefined) {
      hash += `.${maxViews}.${expiryHours}`;
    }
  }
  return `${origin}/view/${cid}#${hash}`;
}

/**
 * Parses the Q-Link URL fragment to extract Share 1, Share 2, and optional access rules.
 */
export function parseQLink(hash?: string): {
  share1: string;
  share2?: string;
  maxViews?: number;
  expiryHours?: number;
} | null {
  try {
    const raw = (hash ?? window.location.hash).replace(/^#/, "").trim();
    if (!raw) {
      console.error("[Qvault Q-VC] URL hash fragment is empty.");
      return null;
    }
    const parts = raw.split(".");
    return {
      share1: parts[0],
      share2: parts[1] || undefined,
      maxViews: parts[2] ? parseInt(parts[2], 10) : undefined,
      expiryHours: parts[3] ? parseInt(parts[3], 10) : undefined,
    };
  } catch (err) {
    console.error("[Qvault Q-VC] Failed to parse Q-Link hash:", err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a browser File object into a Uint8Array via FileReader API.
 */
export function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader    = new FileReader();
    reader.onload   = (e) => resolve(new Uint8Array(e.target!.result as ArrayBuffer));
    reader.onerror  = ()  => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Detects MIME type from magic bytes for rendering decrypted content.
 * Used to reconstruct the blob type after AES-GCM decryption.
 *
 * Extended to support video (MP4, WebM, MOV, AVI, MKV) and
 * audio (MP3, WAV, OGG, FLAC) formats in addition to original types.
 */
export function detectMimeType(bytes: Uint8Array): string {
  // Helper to read hex from a specific byte offset
  const hex12 = Array.from(bytes.slice(0, 12))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const hex8 = hex12.slice(0, 16);
  const hex4 = hex8.slice(0, 8);

  // ── Images ──────────────────────────────────────────────────────────────
  if (hex8.startsWith("89504e47"))          return "image/png";
  if (hex8.startsWith("ffd8ff"))            return "image/jpeg";
  if (hex8.startsWith("47494638"))          return "image/gif";
  if (hex8.startsWith("52494646") && hex12.slice(16, 24) === "57454250")
                                            return "image/webp";  // RIFF....WEBP
  if (hex8.startsWith("52494646"))          return "image/webp";  // RIFF fallback

  // ── Documents ───────────────────────────────────────────────────────────
  if (hex8.startsWith("25504446"))          return "application/pdf";
  if (hex8.startsWith("504b0304"))          return "application/zip";
  if (hex8.startsWith("526172211a07"))      return "application/x-rar-compressed"; // RAR

  // ── Video ────────────────────────────────────────────────────────────────
  // MP4 / MOV / M4V: ftyp box at byte 4 (bytes 4-7 = "ftyp" = 66 74 79 70)
  if (hex12.slice(8, 16) === "66747970") {
    // Check brand to distinguish MP4 vs QuickTime/MOV
    const brand = hex12.slice(16, 24);
    if (brand === "71742020" || brand === "6d6f6f76") return "video/quicktime"; // qt__ or moov
    return "video/mp4";
  }
  // WebM / MKV: EBML magic 1A 45 DF A3
  if (hex4.startsWith("1a45dfa3"))          return "video/webm";
  // AVI: RIFF....AVI (52 49 46 46 xx xx xx xx 41 56 49 20)
  if (hex8.startsWith("52494646") && hex12.slice(16, 24) === "41564920")
                                            return "video/x-msvideo";
  // MKV (Matroska) — also starts with EBML but docType is matroska, same magic
  // (already caught by webm above as best-guess; browser will handle it)

  // ── Audio ────────────────────────────────────────────────────────────────
  // MP3: ID3 tag (49 44 33) or raw frame sync (FF FB / FF F3 / FF F2)
  if (hex4.startsWith("494433"))            return "audio/mpeg"; // ID3
  if (hex4.startsWith("fffb") || hex4.startsWith("fff3") || hex4.startsWith("fff2"))
                                            return "audio/mpeg"; // MP3 frame sync
  // WAV: RIFF....WAVE (52 49 46 46 xx xx xx xx 57 41 56 45)
  if (hex8.startsWith("52494646") && hex12.slice(16, 24) === "57415645")
                                            return "audio/wav";
  // OGG: OggS (4F 67 67 53)
  if (hex4.startsWith("4f676753"))          return "audio/ogg";
  // FLAC: fLaC (66 4C 61 43)
  if (hex4.startsWith("664c6143"))          return "audio/flac";
  // M4A / AAC inside MP4 container — ftyp brand M4A (6d 34 61 20)
  if (hex12.slice(8, 16) === "66747970" && hex12.slice(16, 24) === "6d346120")
                                            return "audio/mp4";

  return "application/octet-stream";
}
