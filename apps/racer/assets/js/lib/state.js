export const State = {
  canvas: null,
  ctx: null,  
  DPR: 1,
  cars: [],
  centerline: [],
  totalLen: 1,
  leftPts: [],
  rightPts: [],
  asphaltPath: null,
  paused: true,
  raceStarted: false,

  LANE_W: 28,
  HALF_W_NORMAL: 1,
  HALF_W_STRAIGHT: 1,

  // ✅ add this:
  straightRange: { start: 0, end: 0 },

  // (optional, but helpful for other modules)
  pitSep: null,
  pitIds: [],
  pitEntryIdx: 0,
  pitExitIdx: 0,
  pitIdSet: new Set(),
  pitStalls: [],

  raceState: 'grid',         // 'grid' | 'countdown' | 'green' | 'finished'
  countdownStart: 0,         // ms timestamp when lights begin
  countdownDurMs: 3200,      // total sequence duration
  selectedCarIdx: 0,         // for panel controls
  viewerCount: 0,            // HUD counter

  startLineIndex: 0,
  startLineS: 0,
  consts: {
    SPRITE_HEADING_OFFSET: Math.PI / 2,
    DUEL_ARC_PX: 260,
    DUEL_CLEAR_GAP_PX: 60,
    EDGE_MARGIN: { normal: 0.60, duel: 0.52 },
    CORNER_PASS_K: 0.0025,
  },
};