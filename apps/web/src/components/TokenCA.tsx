import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { TOKEN_CA } from "../token";

/** Contract address chip with a copy button. */
export default function TokenCA({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(TOKEN_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked */ }
  };
  if (!TOKEN_CA) return null;
  return (
    <button
      onClick={copy}
      title="Copy contract address"
      className={`group inline-flex max-w-full items-center gap-3 rounded-full border border-line bg-panel/80 px-4 py-2.5 text-left transition hover:border-accent/50 ${className}`}
    >
      <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-black">CA</span>
      <span className="truncate font-mono text-xs text-fg sm:text-sm">{TOKEN_CA}</span>
      <span className="shrink-0 text-muted group-hover:text-accent">{copied ? <Check size={15} className="text-accent" /> : <Copy size={15} />}</span>
    </button>
  );
}
