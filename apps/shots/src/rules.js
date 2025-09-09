export const COLOR_TO_SHOTS = Object.freeze({
  blue: 1,
  lblue: 2,        // "light blue" from your view
  green: 5,
  yellow: 10,
  orange: 20,
  pink: 50,
  red: 100,
});

// Gift bundle scheduler parameters
export const GIFT_BASE_RATE = 2;   // 2 shots/sec
export const GIFT_MAX_CAP_25 = 100;
export const GIFT_MAX_CAP_50 = 300;

// Bonus curve: MaxBonus(n) = BONUS_K * n^2
export const BONUS_K = 0.08;

// Weighted randomness tilt: smaller gamma => more generous
export const RAND_GAMMA_BASE = 0.9;
export const RAND_GAMMA_MIN  = 0.55;