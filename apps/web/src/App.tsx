import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import Landing from "./screens/Landing";
import Onboard from "./screens/Onboard";
import ChatApp from "./screens/ChatApp";
import ProfileSetup from "./screens/ProfileSetup";
import { MOCK } from "./api";
import { getSession, hasIdentity } from "./lib/session";

export type Route = "landing" | "onboard" | "profile-setup" | "app" | "profile";
const ROUTES: Route[] = ["landing", "onboard", "profile-setup", "app", "profile"];

const read = (): Route => {
  const h = window.location.hash.replace("#", "");
  const r = (ROUTES as string[]).includes(h) ? (h as Route) : "landing";
  if (MOCK) return r;
  // Route guards (real mode)
  if ((r === "app" || r === "profile" || r === "profile-setup") && !hasIdentity()) return "landing";
  if (r === "onboard" && !getSession()) return "landing";
  return r;
};

export const go = (r: Route) => {
  window.location.hash = r;
};

/** Keep `?mock=1` etc. untouched; only the hash changes. */

export default function App() {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const Screen = route === "onboard" ? Onboard : route === "profile-setup" ? ProfileSetup : route === "app" || route === "profile" ? ChatApp : Landing;
  return (
    <MotionConfig reducedMotion="user">
      <div className="grain h-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={route === "profile" ? "app" : route}
            className="h-full"
            initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <Screen />
          </motion.div>
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
