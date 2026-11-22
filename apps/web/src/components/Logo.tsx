import { go } from "../App";

export default function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  const box = size === "lg" ? "h-10 w-10 text-lg" : "h-8 w-8 text-sm";
  return (
    <button onClick={() => go("landing")} className="group flex items-center gap-2.5" aria-label="Pispt home">
      <span className={`${box} bg-grad grid place-items-center rounded-xl font-display font-extrabold text-black transition-transform group-hover:rotate-[-8deg]`}>
        P
      </span>
      <span className={`font-display font-bold text-fg ${size === "lg" ? "text-xl" : "text-lg"}`}>Pispt</span>
    </button>
  );
}
