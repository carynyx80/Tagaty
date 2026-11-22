// Registration verification (CONTRACT.md §1): wallet ed25519-signs
// UTF-8 "primar-register:v1:" + base64(msgPub). Delegates to @primar/core.
export { verifyRegistration, REGISTER_MESSAGE } from "@primar/core";

export type RegistrationRecord = { wallet: string; msgPub: string; sig: string };
