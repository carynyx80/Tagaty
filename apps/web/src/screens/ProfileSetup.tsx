import { motion } from "motion/react";
import Logo from "../components/Logo";
import ProfileForm from "../components/ProfileForm";
import { go } from "../App";
import { api, short } from "../api";

export default function ProfileSetup() {
  const me = api.me();
  return (
    <div className="relative flex min-h-full flex-col overflow-x-hidden bg-ink">
      <div className="pointer-events-none absolute inset-0">
        <div className="warm-light" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      </div>
      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5">
        <Logo />
        <span className="flex items-center gap-2 text-xs text-muted">
          Step 2 of 2
          <span className="flex gap-1"><span className="h-1 w-6 rounded-full bg-accent" /><span className="h-1 w-6 rounded-full bg-accent" /></span>
        </span>
      </header>
      <main className="relative z-10 flex flex-1 items-start justify-center px-5 pb-16 pt-4 sm:items-center">
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 160, damping: 20 }}
          className="card w-full max-w-lg p-7 sm:p-10"
        >
          <div className="mb-6 flex items-center gap-2 text-xs text-muted">
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 font-mono text-accent">● {short(me.address)}</span>
            key created
          </div>
          <h1 className="font-display text-4xl font-extrabold leading-[0.95] sm:text-5xl">
            Create your <span className="text-grad">profile.</span>
          </h1>
          <p className="mb-8 mt-4 text-[15px] text-muted">Pick a username so friends can find you. Everything else is optional.</p>
          <ProfileForm submitLabel="Continue" onSaved={() => go("app")} />
        </motion.div>
      </main>
    </div>
  );
}
