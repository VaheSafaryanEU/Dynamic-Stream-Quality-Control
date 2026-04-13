// ─────────────────────────────────────────────────────────────────────────────
// index.ts  –  Public surface of dynamic-stream-quality-control
// ─────────────────────────────────────────────────────────────────────────────

// ── Core (substream-based) algorithm — preserved as-is ───────────────────────
export { StreamSelector }      from './StreamSelector.js';
export { PtzZoomGuard }        from './PtzZoomGuard.js';
export { QoSAnalyzer }         from './QoSAnalyzer.js';
export { FrameDropCalculator } from './FrameDropCalculator.js';

// ── Universal / network-aware layer (new) ─────────────────────────────────────
export { UniversalStreamSelector } from './UniversalStreamSelector.js';
export { NetworkAwareAdaptor }     from './NetworkAwareAdaptor.js';
export { StreamAdvisor }           from './StreamAdvisor.js';

export {
  UserPriority,
  UserRequirement,
  NetworkHealthStatus,
} from './types.js';

export type {
  // Inputs
  NetworkQoS,
  Stream,
  StreamSelectorConfig,
  PtzZoomGuardConfig,
  UniversalStreamSelectorConfig,
  // Outputs
  SelectionResult,
  UniversalSelectionResult,
  SingleStreamResult,
  StreamRecommendation,
  ResolutionTier,
  FrameDropStrategy,
  NetworkHealthAnalysis,
} from './types.js';
