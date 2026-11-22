import { go } from "../App";

export default function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  const box = size === "lg" ? "h-11 w-11" : "h-9 w-9";
  return (
    <button onClick={() => go("landing")} className="group flex items-center gap-2.5" aria-label="Pispt home">
      <span className={`${box} overflow-hidden rounded-xl transition-transform group-hover:rotate-[-8deg]`}>
        <img src="/logo.jpg" alt="" className="h-full w-full scale-[1.6] object-cover mix-blend-screen" />
      </span>
      <span className={`font-display font-bold text-fg ${size === "lg" ? "text-xl" : "text-lg"}`}>Pispt</span>
    </button>
  );
}
