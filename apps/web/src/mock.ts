export type Chat = {
  id: string;
  label: string;
  address: string;
  lastMessage: string;
  time: string;
  unread: number;
};

export type Message = {
  id: string;
  chatId: string;
  fromMe: boolean;
  kind: "text" | "payment";
  body: string;
  amount?: number;
  token?: "SOL" | "USDC";
  time: string;
  sig: string | null;
};

export const ME = {
  address: "6T9AvUXqBnSrSxwdLmUnxttgdkSqyWDUQUcYqZf7mkpv",
  label: "you.sol",
};

const sig = (seed: string) =>
  (seed + "5kQ7ZpXv3nHc9Rm2LwT8bYdFgJ4aUe6sNqKx1oVhPiCzMyBtGrD").slice(0, 88).padEnd(88, "x");

export const chats: Chat[] = [
  { id: "c1", label: "maya.sol", address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", lastMessage: "Sent 0.5 SOL privately", time: "2m", unread: 0 },
  { id: "c2", label: "Hx7n…3kPq", address: "Hx7nR4tY2aBvLm9cWq8eZs1dFg5hJk6uPo3iNb7xC3kPq", lastMessage: "Burner is ready. Same time tomorrow?", time: "14m", unread: 2 },
  { id: "c3", label: "ops.sol", address: "Ops1kD7fHq3mZx9vN2cR5tY8uWb4eLa6sGj1pQiKoTnV", lastMessage: "Draft looks good, shipping tonight", time: "1h", unread: 1 },
  { id: "c4", label: "8fGk…Wm2a", address: "8fGkLp3sQ9rT1vXz5bN7cM2dH4jK6wY8eR0uIoPaWm2a", lastMessage: "ok 🤝", time: "3h", unread: 0 },
  { id: "c5", label: "satoshi-fan.sol", address: "SatF4n7qWe2rTy9uIo1pAs3dFg5hJk8lZx6cVb0nMqWe", lastMessage: "Read the paper again. Still holds.", time: "Yesterday", unread: 0 },
  { id: "c6", label: "D3vR…n8Lc", address: "D3vRk2mP7qL9sX4tZ1wY6bN8cV3hJ5gF0eA2uIoKn8Lc", lastMessage: "Invoice settled — thanks", time: "Mon", unread: 0 },
];

export const messages: Message[] = [
  { id: "m1", chatId: "c1", fromMe: false, kind: "text", body: "Hey — is this actually private? Like, nobody can see we're talking?", time: "10:41", sig: sig("a1") },
  { id: "m2", chatId: "c1", fromMe: true, kind: "text", body: "Yep. Content is end-to-end encrypted, and each message lands in a one-time inbox — so on-chain it doesn't link you to me.", time: "10:42", sig: sig("b2") },
  { id: "m3", chatId: "c1", fromMe: false, kind: "text", body: "And I didn't pay any gas for that?", time: "10:42", sig: sig("c3") },
  { id: "m4", chatId: "c1", fromMe: true, kind: "text", body: "Zero. The relayer covers it. Here, I owe you for dinner 👇", time: "10:43", sig: sig("d4") },
  { id: "m5", chatId: "c1", fromMe: true, kind: "payment", body: "Dinner 🍜", amount: 0.5, token: "SOL", time: "10:43", sig: sig("e5") },
  { id: "m6", chatId: "c1", fromMe: false, kind: "text", body: "Got it. Amount's hidden on the explorer too — wild.", time: "10:44", sig: sig("f6") },
  { id: "m7", chatId: "c2", fromMe: false, kind: "text", body: "Burner is ready. Same time tomorrow?", time: "09:12", sig: sig("g7") },
  { id: "m8", chatId: "c3", fromMe: false, kind: "text", body: "Draft looks good, shipping tonight", time: "08:03", sig: sig("h8") },
];

export type Profile = {
  wallet: string;
  username: string;
  displayName?: string;
  bio?: string;
  avatar?: string; // data URL
  updatedAt: number;
};

export const RESERVED_USERNAMES = ["admin", "pispt", "support", "helius", "solana", "root"];

export const profiles: Profile[] = [
  { wallet: ME.address, username: "satoshi_n", displayName: "Satoshi N.", bio: "Building private things on Solana.", updatedAt: Date.now() },
  { wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", username: "maya", displayName: "Maya Chen", bio: "Designer. Coffee. Privacy maximalist.", updatedAt: Date.now() },
  { wallet: "Ops1kD7fHq3mZx9vN2cR5tY8uWb4eLa6sGj1pQiKoTnV", username: "ops_team", displayName: "Ops", updatedAt: Date.now() },
  { wallet: "SatF4n7qWe2rTy9uIo1pAs3dFg5hJk8lZx6cVb0nMqWe", username: "satoshi_fan", displayName: "Satoshi Fan", updatedAt: Date.now() },
  { wallet: "D3vRk2mP7qL9sX4tZ1wY6bN8cV3hJ5gF0eA2uIoKn8Lc", username: "devrel", displayName: "Dev Rel", bio: "Shipping docs.", updatedAt: Date.now() },
];
