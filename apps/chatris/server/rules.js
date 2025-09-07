export const BOARD_W = 10;
export const BOARD_H = 40;

export const CMD_WINDOW_MS = 700;
export const CHAT_COOLDOWN_MS = 400;
export const BASE_GRAVITY_MS = 1000;
export const MIN_GRAVITY_MS = 150;

export const parseCommand = (text='') => {
  const t = text.toLowerCase();
  if (/\bleft\b/.test(t)) return 'left';
  if (/\bright\b/.test(t)) return 'right';
  if (/\brotate\b/.test(t)) return 'rotate';
  return null;
};

// Donation effect mapping
export const donationEffectFrom = (amount) => {
  if (amount >= 100) return { type: 'full_reset' };
  if (amount >= 50)  return { type: 'half_rows' };
  if (amount >= 20)  return { type: 'clear_rows', count: 8 };
  if (amount >= 10)  return { type: 'clear_rows', count: 3 };
  if (amount >= 5)   return { type: 'clear_rows', count: 1 };
  if (amount >= 2)   return { type: 'swap_next' };
  return null;
};

// Gift scaling (linear 2% each by default)
export const giftFactor = (giftCount) => Math.pow(0.98, giftCount); // clamp later

export const gravityFrom = (emaViewers, base=BASE_GRAVITY_MS, giftsWindowCount=0, a=0.15) => {
  const speedMult = Math.max(1, 1 + a * Math.log(emaViewers + 1));
  const ms = base / speedMult * giftFactor(giftsWindowCount);
  return Math.max(MIN_GRAVITY_MS, ms);
};
