export const BOARD_W = 15;
export const BOARD_H = 40;
export const FLOOR_ROWS = 2;   


export const CMD_WINDOW_MS = 300;
export const CHAT_COOLDOWN_MS = 0;

// export const CMD_WINDOW_MS = 700;
// export const CHAT_COOLDOWN_MS = 400;
export const BASE_GRAVITY_MS = 1000;
export const MIN_GRAVITY_MS = 150;

// NEW: tiny global dampener (+0.25% gravity ms → slightly slower)
export const SPEED_DAMP = 2;

// YouTube superchat colors → canonical tier name
export const COLOR_TO_TIER = {
  'rgba(30,136,229,1)':  'blue',
  'rgba(0,229,255,1)':   'lblue',   // light blue / cyan
  'rgba(29,233,182,1)':  'green',
  'rgba(255,202,40,1)':  'yellow',
  'rgba(245,124,0,1)':   'orange',
  'rgba(233,30,99,1)':   'pink',
  'rgba(230,33,23,1)':   'red',
};

// Some parsers might send slightly different strings; normalize them.
const TIER_ALIAS = {
  lightblue: 'lblue',
  cyan:      'lblue',
};

// Tier → effect mapping (tune as you like)
const TIER_TO_EFFECT = {
  blue:   { type: 'swap_next',                     scoreCredit: false },
  lblue:  { type: 'clear_rows', count: 1,          scoreCredit: false },
  green:  { type: 'clear_rows', count: 3,          scoreCredit: false },
  yellow: { type: 'clear_rows', count: 8,          scoreCredit: false  },
  orange: { type: 'half_rows',                     scoreCredit: false  },
  pink:   { type: 'full_reset',                    scoreCredit: false  },
  red:    { type: 'full_reset',                    scoreCredit: true  },
};

export const parseCommand = (text = '') => {
  if (!text) return null;

  // Emoji first (don’t normalize these)
  if (/[⬅←]/u.test(text)) return 'left';
  if (/[➡→]/u.test(text)) return 'right';
  if (/[🔄🔁↻↺⟳⟲]/u.test(text)) return 'rotate';

  // Normalize accents, case, punctuation
  let t = text
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')                        // collapse non-words
    .trim();

  // Squash letter spam: riiiiight -> rright (keeps at most 2 repeats)
  t = t.replace(/([a-z])\1{2,}/g, '$1$1');

  // Word-boundary matches + common shorthands
  if (/\b(left|lf|lft)\b/.test(t)) return 'left';
  if (/\b(right|rt|rgt)\b/.test(t)) return 'right';
  if (/\b(rotate|rot|spin|cw|ccw|clockwise|counterclockwise)\b/.test(t)) return 'rotate';

  return null;
};

// Donation effect mapping
export function donationEffectFromTier(tier) {
  const t = String(tier || '').toLowerCase();
  // light blue & blue are reserved for movement/drop now → no board effects
  if (t === 'lightblue' || t === 'lblue' || t === 'cyan' || t === 'blue') return null;

  // Adjust to taste:
  if (t === 'green')  return { type: 'clear_rows', count: 1 };
  if (t === 'yellow') return { type: 'clear_rows', count: 3 };
  if (t === 'orange') return { type: 'clear_rows', count: 8 };
  if (t === 'pink')   return { type: 'half_rows' };
  if (t === 'red')    return { type: 'full_reset' };
  return null;
}

// Gift scaling (linear 2% each by default)
export const giftFactor = (giftCount) => Math.pow(0.98, giftCount); // clamp later

export const gravityFrom = (
  emaViewers,
  base = BASE_GRAVITY_MS,
  giftsWindowCount = 0,
  a = 0.15,
  speedDamp = SPEED_DAMP
) => {
  const speedMult = Math.max(1, 1 + a * Math.log(emaViewers + 1));
  const msRaw = (base / speedMult) * giftFactor(giftsWindowCount) * speedDamp;
  return Math.max(MIN_GRAVITY_MS, msRaw);
};

// Robust helper: figure out tier from tier/color/amount.
export function effectFromSuperchat(sc = {}) {
  // Prefer explicit tier
  let tier = (sc.tier || '').toString().toLowerCase().trim().replace(/[^a-z]/g, '');
  if (TIER_ALIAS[tier]) tier = TIER_ALIAS[tier];

  // Then color (primary) → tier
  if (!tier) {
    const rawColor = (sc.color || sc.colorVars?.primary || '').replace(/\s+/g, '');
    if (rawColor && COLOR_TO_TIER[rawColor]) tier = COLOR_TO_TIER[rawColor];
  }

  if (tier && TIER_TO_EFFECT[tier]) return { ...TIER_TO_EFFECT[tier], tier };

  // Fallback to legacy amount mapping (keeps your old behavior working)
  const amt = Number(sc.amount_float ?? sc.amount ?? 0);
  const fallback = donationEffectFrom(amt);
  return fallback ? { ...fallback, scoreCredit: true } : null;
}
