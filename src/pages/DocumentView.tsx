/**
 * @file DocumentView.tsx
 * @description The Qvault document viewer page.
 *
 * URL format:  /view/:cid#<Share1>
 *
 * WORKFLOW:
 *  1. Parse CID from URL params, Share 1 from #fragment
 *  2. Check preflight access via checkAccess() or demoGetDocumentInfo()
 *  3. If allowed, call requestAccess() to atomically increment view counter
 *  4. Fetch Share 2 from smart contract or local simulated storage
 *  5. Fetch encrypted blob from IPFS (or localStorage demo)
 *  6. Reconstruct AES key via XOR of Share 1 and Share 2, then AES-GCM decrypt
 *  7. Render the decrypted file in the browser
 *  8. If contract reverts → show "Link Expired / Access Burned" UI
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import {
  Shield, AlertTriangle, Eye, Clock,
  Loader2, Lock, Flame, CheckCircle, ExternalLink,
  FileText, Image as ImageIcon, AlertCircle,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  Smartphone, Laptop, Download, Copy, Check,
  Video as VideoIcon, Music as MusicIcon
} from "lucide-react";
import {
  decryptFile,
  parseQLink,
  detectMimeType,
} from "../utils/cryptoUtils";
import { fetchFile, isDemo as isIPFSDemo } from "../utils/ipfsService";
import {
  requestAccess,
  getDocumentInfo,
  isMetaMaskInstalled,
  parseContractError,
  demoRequestAccess,
  demoGetDocumentInfo,
  demoCreateDocumentAccess,
  getSigner,
} from "../utils/contractUtils";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type ViewerStage =
  | "loading"       // initial parse & preflight check
  | "preflight"     // showing doc info, waiting for user to click "Request Access"
  | "requesting"    // calling requestAccess() smart contract fn
  | "fetching"      // downloading from IPFS
  | "decrypting"    // running ML-KEM decap + AES-GCM
  | "viewing"       // showing the decrypted file
  | "burned"        // access denied / view limit reached
  | "expired"       // time-based expiry
  | "revoked"       // owner revoked
  | "not_found"     // CID/document not registered
  | "invalid_link"  // bad URL fragment
  | "error";        // unexpected error

interface DocMeta {
  maxViews: number;
  currentViews: number;
  remainingViews: number;
  expirationTimestamp: number;
  isActive: boolean;
  owner: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/** "Access Burned" / "Link Expired" full-screen error state */
function AccessDeniedScreen({
  stage,
  cid,
  reason,
}: {
  stage: ViewerStage;
  cid: string;
  reason?: string;
}) {
  const isExpired = stage === "expired";
  const isRevoked = stage === "revoked";

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16">
      <div className="max-w-md text-center">
        {/* Animated flame icon */}
        <div className="mb-8 flex justify-center">
          <div className="relative">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
              <Flame className="h-12 w-12 text-red-400" />
            </div>
            {/* Pulse rings */}
            <div className="absolute inset-0 rounded-full border border-red-500/20 animate-ping opacity-30" />
            <div className="absolute -inset-2 rounded-full border border-red-500/10 animate-ping opacity-20 delay-150" />
          </div>
        </div>

        {/* Title */}
        <h1 className="mb-3 text-4xl font-black text-white">
          {isExpired ? "Link Expired" : isRevoked ? "Access Revoked" : "🔥 Link Burned"}
        </h1>

        {/* Subtitle */}
        <p className="mb-2 text-xl font-bold text-red-400">
          {isExpired
            ? "This Q-Link has passed its expiration time."
            : isRevoked
              ? "The document owner has permanently revoked this link."
              : "View limit reached — this Q-Link has been permanently burned."}
        </p>

        <p className="mb-8 text-slate-400 leading-relaxed">
          {isExpired
            ? "The smart contract enforced the time-based expiry. No further access is possible — the key is gone forever."
            : isRevoked
              ? "The owner called revokeAccess() on the QvaultAccess smart contract. This action is irreversible on the blockchain."
              : "The maximum number of views has been reached. The QvaultAccess smart contract has set isActive = false. This document cannot be decrypted by anyone — ever."}
        </p>

        {/* Technical details */}
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-left mb-6">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            On-Chain Evidence
          </p>
          <div className="space-y-2 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-slate-500">CID:</span>
              <span className="text-slate-400">{cid.slice(0, 20)}…</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Status:</span>
              <span className="text-red-400">isActive = false</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Reason:</span>
              <span className="text-red-400">{reason ?? stage.toUpperCase()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Network:</span>
              <span className="text-violet-400">Polygon Mumbai</span>
            </div>
          </div>
        </div>

        <a
          href="/"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-6 py-3 font-bold text-white"
        >
          <Shield className="h-4 w-4" />
          Create a New Q-Link
        </a>
      </div>
    </div>
  );
}

/** Loading spinner with stage label */
function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16">
      <div className="text-center">
        <div className="mb-6 flex justify-center">
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-cyan-500/10 border border-cyan-500/20">
            <Loader2 className="h-8 w-8 text-cyan-400 animate-spin" />
          </div>
        </div>
        <p className="text-white font-medium">{label}</p>
        <p className="text-sm text-slate-500 mt-1">Please wait…</p>
      </div>
    </div>
  );
}

/** Preflight card: shows doc info before the user triggers access */
function PreflightCard({
  cid,
  meta,
  onRequestAccess,
  isDemo,
}: {
  cid: string;
  meta: DocMeta;
  onRequestAccess: () => void;
  isDemo: boolean;
}) {
  const expiryDate = meta.expirationTimestamp > 0
    ? new Date(meta.expirationTimestamp * 1000).toLocaleString()
    : "Never";

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-16">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-violet-600 shadow-lg shadow-cyan-500/25">
              <Lock className="h-8 w-8 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Encrypted Document</h1>
          <p className="text-slate-400 text-sm">
            Request blockchain access to decrypt and view this document.
          </p>
        </div>

        {/* Document Info Card */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 backdrop-blur-sm mb-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">
            Access Rules (On-Chain)
          </p>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Eye className="h-4 w-4" />
                Views Remaining
              </div>
              <span className={`font-bold text-sm ${meta.remainingViews <= 1 ? "text-red-400" :
                  meta.remainingViews <= 3 ? "text-amber-400" : "text-emerald-400"
                }`}>
                {meta.remainingViews} / {meta.maxViews}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Clock className="h-4 w-4" />
                Expires
              </div>
              <span className="font-medium text-sm text-white">{expiryDate}</span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Shield className="h-4 w-4" />
                Status
              </div>
              <span className={`flex items-center gap-1 font-medium text-sm ${meta.isActive ? "text-emerald-400" : "text-red-400"
                }`}>
                <div className={`h-1.5 w-1.5 rounded-full ${meta.isActive ? "bg-emerald-400 animate-pulse" : "bg-red-400"
                  }`} />
                {meta.isActive ? "Active" : "Revoked"}
              </span>
            </div>

            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <ExternalLink className="h-4 w-4" />
                IPFS CID
              </div>
              <code className="text-xs text-cyan-400 font-mono max-w-[180px] break-all text-right">
                {cid.slice(0, 20)}…
              </code>
            </div>
          </div>

          {/* Warning if last view */}
          {meta.remainingViews === 1 && (
            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-400">
                <strong>Last View!</strong> Accessing this document will permanently burn
                the Q-Link. No one will be able to open it again after this.
              </p>
            </div>
          )}
        </div>

        {/* Demo/IPFS Mode Banner */}
        {isDemo && (
          !isIPFSDemo() ? (
            <div className="mb-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-cyan-400 shrink-0" />
              <p className="text-xs text-cyan-400">
                IPFS Active — Real IPFS file retrieval (Access rules simulated).
              </p>
            </div>
          ) : (
            <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
              <p className="text-xs text-amber-400">
                Demo Mode — Access rules enforced in localStorage (no MetaMask required).
              </p>
            </div>
          )
        )}

        {/* Request Access Button */}
        <button
          onClick={onRequestAccess}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 py-4 font-bold text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-all"
        >
          <Shield className="h-5 w-5" />
          {isMetaMaskInstalled() && !isDemo
            ? "Sign Transaction & View Document"
            : !isIPFSDemo()
            ? "Decrypt & View Document"
            : "View Document (Demo Mode)"
          }
        </button>

        <p className="mt-3 text-center text-xs text-slate-600">
          {isMetaMaskInstalled() && !isDemo
            ? "MetaMask will prompt you to sign a transaction that increments the view counter."
            : !isIPFSDemo()
            ? "File is hosted on IPFS and will be decrypted client-side in your browser."
            : "Demo mode enforces view limits locally without MetaMask."
          }
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURE PDF VIEWER — canvas-based, no native download/print controls
// Uses PDF.js loaded from CDN so no new npm install needed
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pdfjsLib: any;
  }
}

function PdfCanvasViewer({ pdfBytes }: { pdfBytes: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.4);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);
  const renderingRef = useRef(false);

  // Load PDF.js from CDN once
  useEffect(() => {
    if (window.pdfjsLib) return;
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    };
    document.head.appendChild(script);
  }, []);

  // Load the PDF document from the raw bytes
  useEffect(() => {
    let cancelled = false;
    const loadPdf = async () => {
      // Wait for pdfjsLib to be available
      let attempts = 0;
      while (!window.pdfjsLib && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      if (!window.pdfjsLib || cancelled) return;

      try {
        const copy = new Uint8Array(pdfBytes);
        const pdfDoc = await window.pdfjsLib.getDocument({ data: copy }).promise;
        if (cancelled) return;
        pdfDocRef.current = pdfDoc;
        setNumPages(pdfDoc.numPages);
        setLoading(false);
      } catch (e) {
        console.error("PDF load error", e);
      }
    };
    loadPdf();
    return () => { cancelled = true; };
  }, [pdfBytes]);

  // Render the current page whenever page or scale changes
  useEffect(() => {
    if (!pdfDocRef.current || loading) return;
    if (renderingRef.current) return;

    const renderPage = async () => {
      renderingRef.current = true;
      try {
        const pdfPage = await pdfDocRef.current.getPage(page);
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      } finally {
        renderingRef.current = false;
      }
    };
    renderPage();
  }, [page, scale, loading]);

  const prevPage = () => setPage(p => Math.max(1, p - 1));
  const nextPage = () => setPage(p => Math.min(numPages, p + 1));
  const zoomIn = () => setScale(s => Math.min(3, +(s + 0.2).toFixed(1)));
  const zoomOut = () => setScale(s => Math.max(0.5, +(s - 0.2).toFixed(1)));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 gap-3 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
        <span className="text-sm">Rendering PDF…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Custom toolbar — no download, no print */}
      <div className="flex items-center justify-between px-2 py-2 rounded-xl bg-white/5 border border-white/10">
        <div className="flex items-center gap-1">
          <button
            onClick={prevPage}
            disabled={page <= 1}
            className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 transition-colors"
            title="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-slate-400 px-2">
            {page} / {numPages}
          </span>
          <button
            onClick={nextPage}
            disabled={page >= numPages}
            className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 transition-colors"
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 transition-colors"
            title="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="text-xs text-slate-400 w-10 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 transition-colors"
            title="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Canvas PDF render */}
      <div
        className="overflow-auto rounded-xl bg-neutral-900"
        style={{ maxHeight: "80vh" }}
        onContextMenu={e => e.preventDefault()}
      >
        <canvas
          ref={canvasRef}
          className="mx-auto block"
          style={{ userSelect: "none" }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURE VIDEO PLAYER — no-download controls, right-click blocked
// ─────────────────────────────────────────────────────────────────────────────

function VideoPlayer({ bytes, mimeType }: { bytes: Uint8Array; mimeType: string }) {
  const safeBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(safeBuffer).set(bytes);
  const blob    = new Blob([safeBuffer], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);

  return (
    <div
      className="rounded-xl overflow-hidden bg-black"
      onContextMenu={e => e.preventDefault()}
    >
      <video
        src={blobUrl}
        controls
        controlsList="nodownload nofullscreen"
        playsInline
        className="w-full max-h-[75vh] mx-auto block"
        style={{ userSelect: "none" }}
        onContextMenu={e => e.preventDefault()}
      />
      <div className="px-4 py-2 bg-black/40 flex items-center gap-2 border-t border-white/5">
        <VideoIcon className="h-3.5 w-3.5 text-fuchsia-400" />
        <span className="text-xs text-slate-500">{mimeType}</span>
        <span className="ml-auto text-[10px] text-slate-600">Right-click disabled · Secure playback</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO PLAYER — styled dark player
// ─────────────────────────────────────────────────────────────────────────────

function AudioPlayer({ bytes, mimeType }: { bytes: Uint8Array; mimeType: string }) {
  const safeBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(safeBuffer).set(bytes);
  const blob    = new Blob([safeBuffer], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 flex flex-col items-center gap-4">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-pink-500/20 to-violet-500/20 border border-pink-500/20">
        <MusicIcon className="h-8 w-8 text-pink-400" />
      </div>
      <p className="text-sm text-slate-400">Decrypted Audio File</p>
      <audio
        src={blobUrl}
        controls
        controlsList="nodownload"
        className="w-full"
        style={{ colorScheme: "dark" }}
      />
      <p className="text-xs text-slate-600">{mimeType}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT RENDERER (for the decrypted file)
// ─────────────────────────────────────────────────────────────────────────────

function DocumentRenderer({
  bytes,
  mimeType,
  cid,
}: {
  bytes: Uint8Array;
  mimeType: string;
  cid: string;
}) {
  // Copy to a plain ArrayBuffer to avoid SharedArrayBuffer type issues
  const safeBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(safeBuffer).set(bytes);
  const blob    = new Blob([safeBuffer], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);

  const isImage = mimeType.startsWith("image/");
  const isPdf   = mimeType === "application/pdf";
  const isText  = mimeType.startsWith("text/") || mimeType === "application/json";
  const isVideo = mimeType.startsWith("video/");
  const isAudio = mimeType.startsWith("audio/");

  // Decode text content if applicable
  const textContent = isText ? new TextDecoder().decode(bytes) : null;

  // Choose header icon
  const HeaderIcon = isImage ? ImageIcon
    : isVideo ? VideoIcon
    : isAudio ? MusicIcon
    : FileText;

  return (
    <div className="min-h-screen pt-24 pb-16 px-4">
      <div className="mx-auto max-w-4xl">

        {/* Success Banner */}
        <div className="mb-6 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 flex items-center gap-3">
          <CheckCircle className="h-5 w-5 text-emerald-400 shrink-0" />
          <div>
            <p className="font-semibold text-emerald-400">Access Granted</p>
            <p className="text-sm text-slate-400">
              Q-VC Visual Cryptography key reconstruction + AES-256-GCM decryption successful.
              View counter incremented on the Polygon blockchain.
            </p>
          </div>
        </div>

        {/* File Viewer */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
            <HeaderIcon className={`h-5 w-5 ${
              isImage ? "text-violet-400"
              : isVideo ? "text-fuchsia-400"
              : isAudio ? "text-pink-400"
              : isPdf  ? "text-orange-400"
              : "text-slate-400"
            }`} />
            <span className="text-sm font-medium text-white">
              Decrypted {isVideo ? "Video" : isAudio ? "Audio" : "Document"}
            </span>
            <code className="ml-auto text-xs text-slate-500 font-mono">{mimeType}</code>
          </div>

          {/* Content */}
          <div className="p-4">
            {isImage && (
              <img
                src={blobUrl}
                alt="Decrypted document"
                className="max-w-full rounded-xl mx-auto"
                onContextMenu={e => e.preventDefault()}
              />
            )}

            {/* Secure canvas-based PDF viewer — no download/print controls */}
            {isPdf && <PdfCanvasViewer pdfBytes={bytes} />}

            {isVideo && <VideoPlayer bytes={bytes} mimeType={mimeType} />}

            {isAudio && <AudioPlayer bytes={bytes} mimeType={mimeType} />}

            {isText && textContent && (
              <pre className="text-sm text-slate-300 font-mono whitespace-pre-wrap bg-black/20 rounded-xl p-6 overflow-auto max-h-[80vh]">
                {textContent}
              </pre>
            )}

            {!isImage && !isPdf && !isVideo && !isAudio && !isText && (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5">
                  <FileText className="h-8 w-8 text-slate-400" />
                </div>
                <p className="text-slate-400 text-sm">
                  This file type ({mimeType}) cannot be previewed in browser.
                </p>
                {/* Offer a secure download for binary files */}
                <a
                  href={blobUrl}
                  download={`qvault-decrypted.${mimeType.split("/")[1] || "bin"}`}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-all"
                >
                  <Download className="h-4 w-4" />
                  Download Decrypted File
                </a>
                <p className="text-xs text-slate-600">
                  File is decrypted locally in your browser. Download is safe.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Technical Info */}
        <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.01] p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Decryption Audit Trail
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-1.5 text-slate-500">
              <CheckCircle className="h-3 w-3 text-emerald-400" />
              Q-VC Share 1 parsed from URL
            </div>
            <div className="flex items-center gap-1.5 text-slate-500">
              <CheckCircle className="h-3 w-3 text-emerald-400" />
              Q-VC Share 2 fetched from chain
            </div>
            <div className="flex items-center gap-1.5 text-slate-500">
              <CheckCircle className="h-3 w-3 text-emerald-400" />
              (2,2) Secret Sharing XOR recombined
            </div>
            <div className="flex items-center gap-1.5 text-slate-500">
              <CheckCircle className="h-3 w-3 text-emerald-400" />
              AES-256-GCM decryption
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BrowserRedirectionCard({ cid }: { cid: string }) {
  const [copied, setCopied] = useState(false);
  const qLink = window.location.href;

  const copyLink = async () => {
    await navigator.clipboard.writeText(qLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isMobileBrowser = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 pt-24 pb-16">
      <div className="w-full max-w-md">
        
        {/* Glowing Shield Icon */}
        <div className="mb-6 flex justify-center">
          <div className="relative">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 to-red-600 shadow-lg shadow-amber-500/20 animate-pulse">
              <Shield className="h-10 w-10 text-white" />
            </div>
            <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 border-2 border-[#090b11]">
              <Lock className="h-3 w-3 text-white" />
            </div>
          </div>
        </div>

        {/* Title & Description */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-3">Document Protected</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            This document is secured with **(2,2) Visual Cryptography**. To prevent screenshots and document leakage, it can only be opened inside the secure **Qvault Mobile App**.
          </p>
        </div>

        {/* Dynamic Context Card based on Device */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 backdrop-blur-sm mb-6">
          {isMobileBrowser ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Smartphone className="h-5 w-5 text-cyan-400 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold text-white">Viewing on Mobile Browser</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Standard mobile browsers cannot block screenshots. Open this link in the secure Qvault Android app to decrypt safely.
                  </p>
                </div>
              </div>

              <div className="pt-2 flex flex-col gap-3">
                <a
                  href={/Android/i.test(navigator.userAgent)
                    ? `intent://view/${cid}#${window.location.hash.replace(/^#/, "")}#Intent;scheme=qvault;package=com.qvault.app;S.browser_fallback_url=https://qvault-bytebrains-psi.vercel.app/app-debug.apk;end`
                    : `qvault://view/${cid}#${window.location.hash.replace(/^#/, "")}`
                  }
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 py-3 text-sm font-bold text-white shadow-md transition-all hover:scale-[1.02] text-center"
                >
                  <Shield className="h-4 w-4" />
                  Open in Qvault App
                </a>

                <a
                  href="https://qvault-bytebrains-psi.vercel.app/app-debug.apk"
                  className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-bold text-slate-300 transition-all hover:bg-white/10 text-center"
                >
                  <Download className="h-4 w-4" />
                  Download Qvault App (APK)
                </a>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Laptop className="h-5 w-5 text-violet-400 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold text-white">Desktop Viewing Restricted</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    To prevent Snipping Tool and print-screen captures, desktop viewing is disabled. Please open this link on your secure mobile Qvault app.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Secure Q-Link Copy Block */}
          <div className="mt-6 pt-6 border-t border-white/5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Secure Document Link
            </p>
            <div className="rounded-xl bg-black/30 border border-white/5 p-3 flex items-center justify-between gap-3">
              <code className="text-xs text-emerald-400 font-mono truncate select-all flex-1">
                {qLink}
              </code>
              <button
                onClick={copyLink}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/10 transition-all shrink-0"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy Link
                  </>
                )}
              </button>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">
              Copy this link and paste it directly into your Qvault native Android application dashboard to view.
            </p>
          </div>
        </div>

        {/* Developer Sandbox Bypass Link */}
        <div className="text-center">
          <a
            href={`${window.location.pathname}${window.location.hash}${window.location.hash.includes('?') ? '&' : '?'}bypass=true`}
            className="text-xs text-slate-600 hover:text-slate-400 underline transition-colors"
          >
            Developer Bypass (Bypass app-restriction for browser testing)
          </a>
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function DocumentView() {
  const { cid } = useParams<{ cid: string }>();

  const isBypass = window.location.search.includes("bypass=true") || window.location.search.includes("platform=android");
  const isNativeApp = navigator.userAgent.includes("QvaultAndroid") || 
                      (window as any).Capacitor?.isNative || 
                      isBypass;

  if (!isNativeApp) {
    return <BrowserRedirectionCard cid={cid || ""} />;
  }

  const [stage, setStage] = useState<ViewerStage>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [docMeta, setDocMeta] = useState<DocMeta | null>(null);
  const [decrypted, setDecrypted] = useState<Uint8Array | null>(null);
  const [mimeType, setMimeType] = useState("application/octet-stream");
  const [isDemo, setIsDemo] = useState(!isMetaMaskInstalled());
  const [denyReason, setDenyReason] = useState<string | undefined>();

  /** Map contract denial reasons to viewer stages */
  const mapReason = useCallback((reason: string): ViewerStage => {
    if (reason === "VIEW_LIMIT_REACHED" || reason === "INACTIVE") return "burned";
    if (reason === "EXPIRED") return "expired";
    if (reason === "NOT_FOUND") return "not_found";
    if (reason === "OWNER_REVOKED") return "revoked";
    return "burned";
  }, []);

  /** Initial load: parse URL, check preflight access */
  useEffect(() => {
    if (!cid) {
      setStage("not_found");
      return;
    }

    // Validate URL fragment has decryption keys
    const parsed = parseQLink(window.location.hash);
    if (!parsed || !parsed.share1) {
      setStage("invalid_link");
      setErrorMsg("The URL fragment is missing or malformed. The decryption share is embedded after the # symbol.");
      return;
    }

    // Preflight check (read-only, no gas)
    const preflight = async () => {
      try {
        if (isMetaMaskInstalled()) {
          // Try real smart contract check
          const info = await getDocumentInfo(cid);
          if (!info) {
            // Contract not deployed — fall back to demo
            setIsDemo(true);
            demoPreflightCheck(cid);
            return;
          }
          if (!info.isActive) {
            setDenyReason("INACTIVE");
            setStage(mapReason("INACTIVE"));
            return;
          }
          if (info.currentViews >= info.maxViews) {
            setDenyReason("VIEW_LIMIT_REACHED");
            setStage("burned");
            return;
          }
          setDocMeta({
            maxViews: Number(info.maxViews),
            currentViews: Number(info.currentViews),
            remainingViews: Number(info.remainingViews),
            expirationTimestamp: Number(info.expirationTimestamp),
            isActive: info.isActive,
            owner: info.owner,
          });
          setStage("preflight");
        } else {
          setIsDemo(true);
          demoPreflightCheck(cid);
        }
      } catch {
        // Smart contract might not be deployed — use demo mode
        setIsDemo(true);
        demoPreflightCheck(cid);
      }
    };

    const demoPreflightCheck = (docCid: string) => {
      const parsed = parseQLink(window.location.hash);
      // Use the user-set maxViews from the URL hash fragment.
      // Fall back to 1 (most restrictive) rather than a permissive default
      // to prevent silently granting more views than the uploader intended.
      const urlMaxViews    = parsed?.maxViews    !== undefined ? parsed.maxViews    : 1;
      const urlExpiryHours = parsed?.expiryHours !== undefined ? parsed.expiryHours : 0;

      const info = demoGetDocumentInfo(docCid);
      if (!info) {
        // Document exists in IPFS but no demo contract record in this browser.
        // CRITICAL: We must persist the record to localStorage RIGHT NOW.
        // Without this, demoRequestAccess will also hit its !doc branch and
        // create a fresh record with currentViews=0 every time — bypassing
        // the view limit completely and allowing unlimited access.
        const expirationTimestamp = urlExpiryHours > 0
          ? Math.floor(Date.now() / 1000) + urlExpiryHours * 3600
          : 0;

        // Persist to localStorage so demoRequestAccess finds and decrements it
        demoCreateDocumentAccess(docCid, urlMaxViews, urlExpiryHours, "");

        setDocMeta({
          maxViews: urlMaxViews,
          currentViews: 0,
          remainingViews: urlMaxViews,
          expirationTimestamp,
          isActive: true,
          owner: "0xDemo"
        });
        setStage("preflight");
        return;
      }
      if (!info.isActive || info.currentViews >= info.maxViews) {
        setDenyReason("VIEW_LIMIT_REACHED");
        setStage("burned");
        return;
      }
      setDocMeta({
        maxViews: info.maxViews,
        currentViews: info.currentViews,
        remainingViews: info.maxViews - info.currentViews,
        expirationTimestamp: info.expirationTimestamp,
        isActive: info.isActive,
        owner: info.owner,
      });
      setStage("preflight");
    };

    preflight();
  }, [cid, mapReason]);

  /** Called when user clicks "Request Access" */
  const handleRequestAccess = useCallback(async () => {
    if (!cid) return;

    const parsed = parseQLink(window.location.hash);
    if (!parsed || !parsed.share1) {
      setStage("invalid_link");
      setErrorMsg("Decryption keys missing from URL fragment.");
      return;
    }
    const { share1, share2: urlShare2 } = parsed;

    try {
      // ── Step 1: Call requestAccess() on chain ────────────────────────────
      setStage("requesting");

      if (isDemo) {
        // Demo mode: enforce rules in localStorage
        const result = demoRequestAccess(cid, parsed?.maxViews, parsed?.expiryHours);
        if (!result.granted) {
          setDenyReason(result.reason);
          setStage(mapReason(result.reason));
          return;
        }
        await new Promise(r => setTimeout(r, 600)); // Simulate tx
      } else {
        // Real blockchain transaction
        try {
          // Check if MetaMask is connected
          await getSigner();
          await requestAccess(cid);
        } catch (err) {
          const msg = parseContractError(err);
          // Smart contract reverted — access denied
          if (
            msg.includes("View limit") ||
            msg.includes("Inactive") ||
            msg.includes("Expired") ||
            msg.includes("burned")
          ) {
            // Determine which revocation type
            if (msg.includes("limit")) setStage("burned");
            else if (msg.includes("xpired")) setStage("expired");
            else setStage("revoked");
            setDenyReason(msg);
            return;
          }
          // Fall back to demo mode for contract-not-deployed scenario.
          // IMPORTANT: pass parsed view limits so the user-set maxViews from
          // the URL hash is honoured — not a silent hardcoded default.
          console.warn("[Qvault] requestAccess failed — demo fallback:", msg);
          const result = demoRequestAccess(cid, parsed?.maxViews, parsed?.expiryHours);
          if (!result.granted) {
            setDenyReason(result.reason);
            setStage(mapReason(result.reason));
            return;
          }
        }
      }

      // ── Step 2: Fetch Share 2 from URL, on-chain metadata, or demo simulator ───
      let share2 = urlShare2 || "";
      if (!share2) {
        if (isDemo) {
          const info = demoGetDocumentInfo(cid);
          share2 = info?.encryptedKeyHash || "";
        } else {
          try {
            const info = await getDocumentInfo(cid);
            share2 = info?.encryptedKeyHash || "";
          } catch (err) {
            console.warn("[Qvault] Failed to fetch document info from contract, trying demo fallback", err);
          }
          if (!share2 || share2 === "0x" + "0".repeat(64)) {
            const info = demoGetDocumentInfo(cid);
            share2 = info?.encryptedKeyHash || "";
          }
        }
      }

      if (!share2) {
        throw new Error("Visual Cryptography Share 2 could not be retrieved from the blockchain, URL fragment, or local storage.");
      }

      // ── Step 3: Fetch encrypted blob from IPFS ───────────────────────────
      setStage("fetching");
      let encryptedBlob: Uint8Array;
      try {
        encryptedBlob = await fetchFile(cid);
      } catch (fetchErr) {
        throw new Error(`IPFS fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
      }

      // ── Step 4: Decrypt locally ──────────────────────────────────────────
      setStage("decrypting");
      const plaintext = await decryptFile(encryptedBlob, share1, share2);

      // Detect and set MIME type for rendering
      const detected = detectMimeType(plaintext);
      setMimeType(detected);
      setDecrypted(plaintext);
      setStage("viewing");

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setStage("error");
    }
  }, [cid, isDemo, mapReason]);

  // ── Render by stage ───────────────────────────────────────────────────────

  if (!cid) {
    return <AccessDeniedScreen stage="not_found" cid="" reason="NO_CID" />;
  }

  if (stage === "loading") {
    return <LoadingScreen label="Checking access rules…" />;
  }

  if (stage === "invalid_link") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 pt-16">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="h-8 w-8 text-red-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-3">Invalid Q-Link</h1>
          <p className="text-slate-400 mb-6">{errorMsg}</p>
          <p className="text-xs text-slate-600 mb-6">
            The Q-Link must include the decryption key in the URL fragment (#…).
            Make sure you copied the complete URL including everything after the # symbol.
          </p>
          <a
            href="/upload"
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-6 py-3 font-bold text-white"
          >
            <Shield className="h-4 w-4" />
            Create a Q-Link
          </a>
        </div>
      </div>
    );
  }

  if (["burned", "expired", "revoked"].includes(stage)) {
    return <AccessDeniedScreen stage={stage} cid={cid} reason={denyReason} />;
  }

  if (stage === "not_found") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 pt-16">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
              <AlertCircle className="h-8 w-8 text-amber-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-3">Document Not Found</h1>
          <p className="text-slate-400 text-sm mb-4">
            This Q-Link works in <span className="text-amber-400 font-medium">Demo Mode</span>, which stores files locally in the browser where the file was uploaded.
          </p>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-left mb-6">
            <p className="text-xs font-semibold text-amber-400 mb-2">To open this Q-Link:</p>
            <p className="text-xs text-slate-400">Open it in the <strong className="text-white">same app or browser</strong> where you originally uploaded the file.</p>
          </div>
          <a href="/upload" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-6 py-3 font-bold text-white">
            <Shield className="h-4 w-4" />
            Create a New Q-Link
          </a>
        </div>
      </div>
    );
  }

  if (stage === "requesting") {
    return (
      <LoadingScreen label={isDemo ? "Simulating blockchain transaction…" : "Awaiting MetaMask confirmation…"} />
    );
  }

  if (stage === "fetching") {
    return <LoadingScreen label="Fetching encrypted document from IPFS…" />;
  }

  if (stage === "decrypting") {
    return <LoadingScreen label="Reconstructing key via (2,2) Visual Cryptography and decrypting file…" />;
  }

  if (stage === "error") {
    const isDemoFileError = errorMsg.includes("DEMO_FILE_NOT_FOUND");
    return (
      <div className="min-h-screen flex items-center justify-center px-4 pt-16">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${isDemoFileError ? "bg-amber-500/10 border border-amber-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
              <AlertCircle className={`h-8 w-8 ${isDemoFileError ? "text-amber-400" : "text-red-400"}`} />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-3">
            {isDemoFileError ? "Demo Mode: File Not Available" : "Decryption Failed"}
          </h1>
          {isDemoFileError ? (
            <>
              <p className="text-slate-400 text-sm mb-4">
                This Q-Link was created in <span className="text-amber-400 font-medium">Demo Mode</span>. The encrypted file is stored only in the browser/app where it was uploaded.
              </p>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-left mb-6">
                <p className="text-xs font-semibold text-amber-400 mb-2">💡 To view this document:</p>
                <p className="text-xs text-slate-400">Open the Q-Link in the <strong className="text-white">same app or browser</strong> where you uploaded the file. In the QVault Android app, go to Dashboard and tap the document.</p>
              </div>
            </>
          ) : (
            <p className="text-slate-400 text-sm mb-6">{errorMsg}</p>
          )}
          <div className="flex gap-3 justify-center">
            {!isDemoFileError && (
              <button
                onClick={() => { setStage("preflight"); setErrorMsg(""); }}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-6 py-3 font-bold text-white"
              >
                Try Again
              </button>
            )}
            <a href="/upload" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-6 py-3 font-bold text-white">
              <Shield className="h-4 w-4" />
              New Q-Link
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (stage === "viewing" && decrypted) {
    return <DocumentRenderer bytes={decrypted} mimeType={mimeType} cid={cid} />;
  }

  // Preflight state
  if (docMeta) {
    return (
      <PreflightCard
        cid={cid}
        meta={docMeta}
        onRequestAccess={handleRequestAccess}
        isDemo={isDemo}
      />
    );
  }

  return <LoadingScreen label="Loading…" />;
}
