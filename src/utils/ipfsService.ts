/**
 * @file ipfsService.ts
 * @description IPFS upload/download utilities for Qvault using the Pinata API.
 *
 * DESIGN NOTES:
 *  - Pinata is used as a pinning service to ensure files remain available.
 *  - The encrypted blob is uploaded as binary (application/octet-stream).
 *  - The server ONLY ever receives ENCRYPTED data — it has no key material.
 *  - Demo mode uses localStorage when Pinata credentials aren't configured.
 *
 * PINATA API REFERENCE: https://docs.pinata.cloud/api-reference/
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const PINATA_API_URL      = "https://api.pinata.cloud";
const PINATA_GATEWAY      = "https://gateway.pinata.cloud/ipfs";
const PUBLIC_IPFS_GATEWAY = "https://ipfs.io/ipfs";

// Vite exposes env vars via import.meta.env — declare it to fix TS error
declare const __PINATA_JWT__: string | undefined;

// Try environment variable first, otherwise fall back to placeholder
const PINATA_JWT: string = (import.meta.env?.VITE_PINATA_JWT as string) || "YOUR_PINATA_JWT_HERE";

// ─────────────────────────────────────────────────────────────────────────────
// INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

export interface UploadResult {
  /** IPFS Content Identifier — immutable address of the uploaded file */
  cid: string;
  /** Full IPFS gateway URL for retrieval */
  gatewayUrl: string;
  /** Size of the uploaded file in bytes */
  size: number;
  /** Whether this was uploaded to real IPFS or demo localStorage */
  isDemo: boolean;
}

export interface QvaultMetadata {
  fileName: string;
  mimeType: string;
  kyberCiphertext: string;
  kyberPublicKey: string;
  uploadedAt: string;
  version: "qvault-v1";
}

// ─────────────────────────────────────────────────────────────────────────────
// PINATA HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function pinataHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${PINATA_JWT}` };
}

export async function testPinataConnection(): Promise<boolean> {
  try {
    const res = await fetch(`${PINATA_API_URL}/data/testAuthentication`, {
      headers: pinataHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uploads the AES-encrypted file blob to IPFS via Pinata.
 * The blob is completely opaque — only the Q-Link holder can decrypt it.
 */
export async function uploadEncryptedFile(
  encryptedBlob: Uint8Array,
  fileName: string
): Promise<UploadResult> {
  console.log(`[Qvault IPFS] Uploading encrypted blob: ${encryptedBlob.length} bytes`);

  // Convert Uint8Array to a safe ArrayBuffer for Blob constructor
  const safeBuffer = new ArrayBuffer(encryptedBlob.byteLength);
  new Uint8Array(safeBuffer).set(encryptedBlob);

  const formData = new FormData();
  const blob     = new Blob([safeBuffer], { type: "application/octet-stream" });
  formData.append("file", blob, `${fileName}.qvault`);
  formData.append("pinataMetadata", JSON.stringify({
    name: `Qvault: ${fileName}`,
    keyvalues: { app: "qvault", version: "v1", encrypted: "true" },
  }));
  formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const response = await fetch(`${PINATA_API_URL}/pinning/pinFileToIPFS`, {
    method: "POST",
    headers: pinataHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`IPFS upload failed (${response.status}): ${errText}`);
  }

  const data = await response.json() as { IpfsHash: string; PinSize: number };
  console.log(`[Qvault IPFS] File uploaded. CID: ${data.IpfsHash}`);

  return {
    cid: data.IpfsHash,
    gatewayUrl: `${PINATA_GATEWAY}/${data.IpfsHash}`,
    size: data.PinSize,
    isDemo: false,
  };
}

/**
 * Uploads document metadata JSON to IPFS via Pinata.
 */
export async function uploadMetadata(metadata: QvaultMetadata): Promise<string> {
  const body = JSON.stringify({
    pinataContent: metadata,
    pinataMetadata: { name: `Qvault Metadata: ${metadata.fileName}` },
    pinataOptions: { cidVersion: 1 },
  });

  const response = await fetch(`${PINATA_API_URL}/pinning/pinJSONToIPFS`, {
    method: "POST",
    headers: { ...pinataHeaders(), "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Metadata upload failed (${response.status}): ${errText}`);
  }

  const data = await response.json() as { IpfsHash: string };
  return data.IpfsHash;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION & HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that the fetched bytes are actual binary data and not HTML/JSON error pages
 * returned by rate-limited or misconfigured IPFS gateways.
 */
function validateEncryptedBytes(bytes: Uint8Array): void {
  if (bytes.length < 12) {
    throw new Error("The fetched file is empty or corrupted (too small to contain AES-GCM IV).");
  }

  try {
    const text = new TextDecoder().decode(bytes.slice(0, 200)).trim();
    const lowerText = text.toLowerCase();

    if (
      lowerText.startsWith("<!doctype") ||
      lowerText.startsWith("<html") ||
      lowerText.startsWith("<div") ||
      lowerText.startsWith("<p") ||
      lowerText.startsWith("<!doc")
    ) {
      throw new Error(
        "IPFS gateway returned an HTML error page instead of the encrypted file. " +
        "This usually means the file hasn't finished propagating on the IPFS network yet, or the gateway is rate-limiting requests."
      );
    }

    if (lowerText.startsWith("{") && (lowerText.includes('"error"') || lowerText.includes('"message"'))) {
      try {
        const json = JSON.parse(text.slice(0, text.indexOf("}") + 1)) as { error?: string; message?: string };
        throw new Error(`Gateway returned an API error: ${json.error || json.message || "Unknown error"}`);
      } catch {
        // Not valid JSON, ignore
      }
    }
  } catch (e) {
    if (e instanceof Error && (e.message.includes("HTML error page") || e.message.includes("API error"))) {
      throw e;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD / FETCH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches encrypted file from IPFS, trying multiple gateways for reliability.
 */
export async function fetchEncryptedFile(cid: string): Promise<Uint8Array> {
  console.log(`[Qvault IPFS] Fetching CID: ${cid}`);

  const gateways = [
    `${PINATA_GATEWAY}/${cid}`,
    `${PUBLIC_IPFS_GATEWAY}/${cid}`,
    `https://cloudflare-ipfs.com/ipfs/${cid}`,
    `https://dweb.link/ipfs/${cid}`,
    `https://nftstorage.link/ipfs/${cid}`,
    `https://cf-ipfs.com/ipfs/${cid}`,
    `https://4everland.io/ipfs/${cid}`
  ];

  let lastError: Error = new Error("No gateways tried");

  for (const url of gateways) {
    try {
      console.log(`[Qvault IPFS] Trying: ${url}`);
      
      const isPinataUrl = url.startsWith(PINATA_GATEWAY);
      const headers: Record<string, string> = {};
      if (isPinataUrl && PINATA_JWT && PINATA_JWT !== "YOUR_PINATA_JWT_HERE") {
        headers["Authorization"] = `Bearer ${PINATA_JWT}`;
      }

      const response = await fetch(url, { 
        headers, 
        signal: AbortSignal.timeout(30_000) 
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buf = await response.arrayBuffer();
      const u8 = new Uint8Array(buf);
      
      // Ensure we got the actual encrypted file, not a gateway HTML/JSON error page
      validateEncryptedBytes(u8);
      
      console.log(`[Qvault IPFS] Successfully fetched ${buf.byteLength} bytes from gateway: ${url}`);
      return u8;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Qvault IPFS] Gateway failed (${url}):`, lastError.message);
    }
  }

  throw new Error(`Failed to fetch from IPFS: ${lastError.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO MODE (localStorage fallback)
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_PREFIX = "qvault_demo_";
const DEMO_INDEX  = "qvault_demo_index";

/**
 * Simulates IPFS upload using localStorage for hackathon demo.
 * NOT for production — data is ephemeral and limited to ~5MB.
 */
export async function demoUpload(
  encryptedBlob: Uint8Array,
  fileName: string
): Promise<UploadResult> {
  // Generate a pseudo-CID from a hash of the encrypted content
  let hash = 5381;
  for (let i = 0; i < Math.min(encryptedBlob.length, 256); i++) {
    hash = ((hash << 5) + hash) ^ encryptedBlob[i];
    hash = hash & hash; // Convert to 32bit int
  }
  const mockCid = `Qm${Math.abs(hash).toString(36).padStart(8, "0")}${Date.now().toString(36)}`;

  try {
    // Store as a regular array (localStorage is string-only)
    const entry = JSON.stringify({
      data: Array.from(encryptedBlob),
      fileName,
      uploadedAt: Date.now(),
    });
    localStorage.setItem(`${DEMO_PREFIX}${mockCid}`, entry);

    // Update the demo index for dashboard listing
    const existing = JSON.parse(localStorage.getItem(DEMO_INDEX) ?? "[]") as string[];
    if (!existing.includes(mockCid)) {
      existing.unshift(mockCid);
      localStorage.setItem(DEMO_INDEX, JSON.stringify(existing.slice(0, 20)));
    }
  } catch {
    console.warn("[Qvault Demo] localStorage write failed (quota exceeded?)");
  }

  console.log(`[Qvault Demo] Stored locally with mock CID: ${mockCid}`);
  return { cid: mockCid, gatewayUrl: `#demo/${mockCid}`, size: encryptedBlob.length, isDemo: true };
}

/**
 * Retrieves an encrypted blob from localStorage (demo mode).
 */
export async function demoFetch(cid: string): Promise<Uint8Array> {
  const stored = localStorage.getItem(`${DEMO_PREFIX}${cid}`);
  if (!stored) {
    throw new Error(
      `DEMO_FILE_NOT_FOUND: Demo document not found in this browser's localStorage (CID: ${cid}). ` +
      `localStorage may have been cleared — please re-upload.`
    );
  }
  const { data } = JSON.parse(stored) as { data: number[]; fileName: string };
  return new Uint8Array(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED API (auto-selects Pinata vs Demo)
// ─────────────────────────────────────────────────────────────────────────────

export function isDemo(): boolean {
  return !PINATA_JWT || PINATA_JWT === "YOUR_PINATA_JWT_HERE";
}

/** Upload encrypted file — auto-selects real IPFS or demo mode */
export async function uploadFile(
  encryptedBlob: Uint8Array,
  fileName: string
): Promise<UploadResult> {
  if (isDemo()) {
    console.warn("[Qvault] No Pinata JWT — using DEMO mode.");
    return demoUpload(encryptedBlob, fileName);
  }
  return uploadEncryptedFile(encryptedBlob, fileName);
}

/** 
 * Fetch encrypted file — attempts local storage cache first, then falls back to real IPFS.
 * This ensures cross-browser / cross-mode links work seamlessly.
 */
export async function fetchFile(cid: string): Promise<Uint8Array> {
  // 1. Always check local storage first as a fast/instant lookup
  try {
    const localData = await demoFetch(cid);
    console.log("[Qvault Fetch] File found in local storage cache.");
    return localData;
  } catch (err) {
    console.log("[Qvault Fetch] File not found in local storage cache. Attempting IPFS gateways...");
  }

  // 2. Fetch from real IPFS gateways
  try {
    return await fetchEncryptedFile(cid);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `DEMO_FILE_NOT_FOUND: The file (CID: ${cid}) could not be retrieved.\n\n` +
      `• If this Q-Link was created in Demo Mode (e.g. inside the local app or when Pinata wasn't configured), the file is ONLY stored in that specific browser's localStorage. Please open it in the same app or browser where you uploaded it.\n` +
      `• If this was a real IPFS upload, the gateways might be experiencing temporary connection issues, or the file is still propagating on the network. Please wait a moment and try again.`
    );
  }
}
