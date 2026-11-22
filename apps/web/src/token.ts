/**
 * $PISPT token details. Paste the pump.fun link here and the homepage shows
 * the contract address and a "Buy $PISPT" button. Leave empty to hide both.
 */
export const PUMPFUN_URL = "https://pump.fun/coin/6iYpas856GGP55WTZv3q2po7mEG3T8KfB7bVj5v1pump";

/** Contract address, taken from the pump.fun link (https://pump.fun/coin/<CA>). */
export const TOKEN_CA: string = (() => {
  const m = PUMPFUN_URL.match(/([1-9A-HJ-NP-Za-km-z]{32,48})(?:[/?#]|$)/);
  return m ? m[1] : "";
})();

export const TOKEN_LIVE = Boolean(PUMPFUN_URL && TOKEN_CA);
