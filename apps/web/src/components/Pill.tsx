import { motion, type HTMLMotionProps } from "motion/react";

type Props = HTMLMotionProps<"button"> & { variant?: "accent" | "ghost" | "grad" };

const styles = {
  accent: "bg-accent text-black hover:bg-accent-soft active:bg-accent-deep shadow-[0_0_24px_rgba(139,255,22,0.25)]",
  grad: "bg-grad text-black",
  ghost: "glass text-fg hover:border-accent/50",
};

export default function Pill({ variant = "accent", className = "", ...rest }: Props) {
  return (
    <motion.button
      whileHover={{ scale: 1.04, y: -2 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 420, damping: 18 }}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 font-semibold disabled:opacity-40 ${styles[variant]} ${className}`}
      {...rest}
    />
  );
}
