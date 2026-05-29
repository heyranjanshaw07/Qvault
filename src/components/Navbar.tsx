/**
 * @file Navbar.tsx
 * @description Global navigation bar.
 */

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Shield, Menu, X, ChevronRight } from "lucide-react";

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  const navLinks = [
    { to: "/",          label: "Home"      },
    { to: "/upload",    label: "Upload"    },
    { to: "/dashboard", label: "Dashboard" },
  ];

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-[#080B14]/80 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex h-16 items-center justify-between">

          {/* ── Logo ─────────────────────────────────────────────────────── */}
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-violet-600 shadow-lg shadow-cyan-500/20">
              <Shield className="h-4 w-4 text-white" />
              {/* Animated pulse ring */}
              <div className="absolute inset-0 rounded-lg bg-cyan-400/30 animate-ping opacity-0 group-hover:opacity-100 duration-1000" />
            </div>
            <span className="font-bold text-lg tracking-tight">
              Q<span className="text-cyan-400">vault</span>
            </span>
          </Link>

          {/* ── Desktop Nav Links ─────────────────────────────────────────── */}
          <div className="hidden md:flex items-center gap-1">
            {navLinks.map(link => (
              <Link
                key={link.to}
                to={link.to}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                  location.pathname === link.to
                    ? "text-cyan-400 bg-cyan-400/10"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* ── Mobile menu toggle ────────────────────────────────────────── */}
          <div className="flex items-center">
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="md:hidden rounded-lg p-1.5 text-slate-400 hover:text-white hover:bg-white/5"
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Mobile Menu ─────────────────────────────────────────────────── */}
      {menuOpen && (
        <div className="md:hidden border-t border-white/5 bg-[#080B14] px-4 py-3 space-y-1">
          {navLinks.map(link => (
            <Link
              key={link.to}
              to={link.to}
              onClick={() => setMenuOpen(false)}
              className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium ${
                location.pathname === link.to
                  ? "text-cyan-400 bg-cyan-400/10"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              {link.label}
              <ChevronRight className="h-4 w-4 opacity-50" />
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
