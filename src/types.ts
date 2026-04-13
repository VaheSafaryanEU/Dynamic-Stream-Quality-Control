// ─────────────────────────────────────────────────────────────────────────────
// types.ts  –  All public types & interfaces for the adaptive stream selector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * User-facing priority mode.
 *
 * RESOLUTION_PRIORITY – prefer the highest spatial resolution that fits the
 *   current bandwidth. No frame dropping is ever applied — a clean lower-res
 *   stream is always preferred over a choppy high-res one.
 *
 * FPS_PRIORITY – prefer the smoothest motion.
 *   The algorithm selects the stream with the highest frame rate that fits
 *   within the current usable bandwidth. Frame dropping is used as a last
 *   resort when no stream fits at all.
 */
export enum UserPriority {
  RESOLUTION_PRIORITY = 'RESOLUTION_PRIORITY',
  FPS_PRIORITY        = 'FPS_PRIORITY',
}

/**
 * High-level user requirement, independent of whether multiple streams exist.
 *
 * AUTO         – Let the algorithm decide based on network health.
 *                On a healthy network it behaves like BEST_QUALITY;
 *                on a degraded network it gracefully reduces quality.
 *
 * BEST_QUALITY – Deliver the highest possible resolution and FPS the network
 *                can sustain. Frame dropping is avoided; if the network cannot
 *                support the best stream, the next viable one is chosen.
 *
 * BEST_FPS     – Deliver the smoothest motion even at the cost of resolution.
 *                Frame dropping is applied when necessary to maintain fluidity.
 *
 * LOW_LATENCY  – Minimize buffering and glass-to-glass delay. Chooses a
 *                lower-bitrate stream so the link stays uncongested, even if
 *                the network could technically carry a higher-quality one.
 *                Useful for interactive applications (PTZ control, two-way AV).
 */
export enum UserRequirement {
  AUTO         = 'AUTO',
  BEST_QUALITY = 'BEST_QUALITY',
  BEST_FPS     = 'BEST_FPS',
  LOW_LATENCY  = 'LOW_LATENCY',
}

/**
 * Qualitative label derived from raw QoS measurements.
 * Used for logging, dashboards, and downstream decision gates.
 */
export enum NetworkHealthStatus {
  EXCELLENT = 'EXCELLENT', // Near-ideal conditions
  GOOD      = 'GOOD',      // Minor impairments, transparent to viewer
  FAIR      = 'FAIR',      // Noticeable degradation, adaptation needed
  POOR      = 'POOR',      // Heavy impairment, minimal stream mandatory
  CRITICAL  = 'CRITICAL',  // Near-unusable – frame dropping or abort
}

// ─── Input types ─────────────────────────────────────────────────────────────

/**
 * Real-time network Quality-of-Service snapshot.
 * These values should be measured over a sliding window (e.g. last 2–5 s).
 */
export interface NetworkQoS {
  /** Estimated available bandwidth in kilobits per second (Kbps). */
  bandwidthKbps: number;

  /** Round-trip time in milliseconds. */
  latencyMs: number;

  /**
   * Packet delay variation (jitter) in milliseconds.
   * High jitter causes rebuffering even when average bandwidth seems sufficient.
   */
  jitterMs: number;

  /**
   * Fraction of packets lost, expressed as a percentage (0–100).
   * Values above ~5 % degrade TCP throughput significantly via retransmission.
   */
  packetLossPercent: number;
}

/**
 * Description of a single available video stream / substream.
 * No stream is generated at runtime; these are pre-encoded variants.
 */
export interface Stream {
  /** Unique identifier – used for logging and equality checks. */
  id: string;

  /** Human-readable label, e.g. "Main" or "SubStream1". */
  label: string;

  /**
   * Frame width in pixels. Pass 0 if not yet known (e.g. probe pending).
   * The selector uses bitrate as a quality proxy when resolution is unknown.
   */
  widthPx: number;

  /**
   * Frame height in pixels. Pass 0 if not yet known.
   */
  heightPx: number;

  /**
   * Nominal frames per second. Pass 0 if not yet known.
   * The selector falls back to bitrate/1000 as an fps proxy when fps=0.
   */
  fps: number;

  /**
   * Required network bitrate in Kbps to deliver this stream without loss.
   * Should include codec overhead (audio, RTP/RTSP headers, etc.).
   */
  bitrateKbps: number;

  /**
   * Mark exactly ONE stream as the main / highest-quality reference stream.
   * Used by RESOLUTION_PRIORITY to identify what to protect.
   * If omitted, the stream with the highest pixel count is inferred.
   */
  isMainStream?: boolean;
}

// ─── Output / result types ───────────────────────────────────────────────────

/**
 * Frame-dropping strategy — only emitted by FPS_PRIORITY as a last resort
 * when no stream fits the available bandwidth.
 *
 * The consumer must apply this strategy to the packet pipeline manually;
 * this module does NOT touch any packets itself.
 */
export interface FrameDropStrategy {
  /** Whether dropping is currently active. */
  active: boolean;

  /**
   * Periodicity of drops.
   * 1 = no dropping (every frame kept).
   * 2 = keep frame #1, drop frame #2, keep #3 …  (50 % kept)
   * 3 = keep #1, drop #2, drop #3, keep #4 …     (~33 % kept)
   *
   * Maintain an incrementing per-stream frame counter; forward frames where
   * (counter % dropEveryNthFrame === 0). Reset on each keyframe (IDR/I-frame).
   */
  dropEveryNthFrame: number;

  /** Fraction of frames actually forwarded: 1 / dropEveryNthFrame. */
  keepRatio: number;

  /** Resulting effective FPS after the drop pattern is applied. */
  effectiveFps: number;

  /**
   * Estimated effective bitrate after frame dropping.
   * Assumes a roughly linear relationship between frame count and bitrate,
   * which is a safe approximation for CBR/VBR streams with uniform GOP sizes.
   */
  effectiveBitrateKbps: number;

  /** Human-readable explanation of why and how frames are dropped. */
  reason: string;
}

/**
 * Internal result of QoS analysis.
 * Exposes the effective (penalty-adjusted) bandwidth so stream filtering
 * accounts for congestion signals beyond raw bandwidth.
 */
export interface NetworkHealthAnalysis {
  status: NetworkHealthStatus;

  /**
   * Raw bandwidth multiplied by all penalty factors (jitter, packet loss,
   * latency congestion signal). Use this value for stream selection,
   * NOT the raw bandwidthKbps.
   */
  effectiveBandwidthKbps: number;

  /** Composite multiplier in [0, 1] applied to raw bandwidth. */
  bandwidthPenaltyFactor: number;

  /** List of detected network issues for logging / telemetry. */
  issues: string[];
}

/**
 * Final, actionable output of StreamSelector.
 * Contains everything a media server needs to switch streams and/or apply
 * a frame-dropping filter.
 */
export interface SelectionResult {
  /** The stream the server should switch to (or remain on). */
  selectedStream: Stream;

  /**
   * Non-null only when FPS_PRIORITY is active AND no stream fits the budget.
   * When non-null the server SHOULD apply the described packet-drop filter.
   * Always null under RESOLUTION_PRIORITY.
   */
  frameDropStrategy: FrameDropStrategy | null;

  /** Full QoS analysis used to reach this decision. */
  networkHealth: NetworkHealthAnalysis;

  /** Human-readable decision rationale for logging / debugging. */
  reason: string;

  /**
   * Overall perceived-quality estimate in [0, 100].
   * Useful for dashboards and for triggering alerts when quality degrades.
   */
  qualityScore: number;

  /** Unix epoch timestamp (ms) when this decision was produced. */
  timestamp: number;
}

/**
 * Configuration for PtzZoomGuard.
 */
export interface PtzZoomGuardConfig {
  /**
   * How long (ms) to keep RESOLUTION_PRIORITY locked after the last zoom event.
   * Covers the settling period while the QoS probe averages out the bitrate spike.
   * Default: 3 000 ms.
   */
  settleDurationMs?: number;

  /** Called once when the guard transitions from unlocked → locked. */
  onLock?: () => void;

  /** Called once when the settle timer fires and the lock is released. */
  onRelease?: () => void;
}

/**
 * Optional tuning knobs passed to StreamSelector constructor.
 * All fields have sensible defaults; only override when you have measured data.
 */
export interface StreamSelectorConfig {
  /**
   * Fraction of effective bandwidth reserved as a safety buffer.
   * Default: 0.20 (20 %).
   * A stream is only considered viable if its bitrate ≤
   * effectiveBandwidth × (1 − bandwidthSafetyMargin).
   */
  bandwidthSafetyMargin: number;

  /**
   * Minimum effective FPS threshold used by FPS_PRIORITY fallback frame-drop.
   * Default: 5 fps.
   */
  minViableFps: number;
}

// ─── Universal selector types ────────────────────────────────────────────────

/**
 * Result produced by UniversalStreamSelector.
 * A superset of SelectionResult that also exposes the resolved priority and
 * requirement so callers can log or inspect decisions uniformly.
 */
export interface UniversalSelectionResult extends SelectionResult {
  /**
   * The UserRequirement that was passed in (or AUTO if omitted).
   */
  requirement: UserRequirement;

  /**
   * The UserPriority that was derived from the requirement + network state.
   * Useful for debugging AUTO decisions.
   */
  resolvedPriority: UserPriority;

  /**
   * When true the network health is too poor to guarantee viewing comfort even
   * on the lowest available stream. Callers may choose to surface a warning UI
   * or abort playback.
   */
  networkWarning: boolean;
}

/**
 * Result returned when the caller has only a single stream (no substreams).
 * The algorithm cannot switch streams, so it reports whether the single stream
 * is viable and optionally prescribes frame dropping to make it fit.
 */
export interface SingleStreamResult {
  /** The only available stream — always returned regardless of health. */
  stream: Stream;

  /**
   * Whether the stream's bitrate fits within the usable bandwidth.
   * false means the stream will exceed the link capacity; consider reducing
   * encoder bitrate or switching to a lower preset if possible.
   */
  viable: boolean;

  /**
   * Frame-drop strategy to apply when viable=false and the requirement is
   * BEST_FPS or AUTO on a degraded network. null when viable=true or when the
   * requirement is BEST_QUALITY / LOW_LATENCY (no dropping desired).
   */
  frameDropStrategy: FrameDropStrategy | null;

  /** Full QoS analysis for logging and dashboards. */
  networkHealth: NetworkHealthAnalysis;

  /**
   * Human-readable explanation of the decision.
   * Includes why the stream is or is not viable and what action is prescribed.
   */
  reason: string;

  /**
   * Overall perceived-quality estimate in [0, 100].
   * Accounts for network health and any frame-drop penalty.
   */
  qualityScore: number;

  /** Unix epoch timestamp (ms) when this decision was produced. */
  timestamp: number;
}

/**
 * Configuration for UniversalStreamSelector.
 */
export interface UniversalStreamSelectorConfig extends StreamSelectorConfig {
  /**
   * For LOW_LATENCY mode: fraction of usable bandwidth to target.
   * The selector picks the highest-quality stream whose bitrate stays
   * within (usableBandwidth × lowLatencyBudgetFraction).
   * Default: 0.50 (use at most 50 % of available bandwidth).
   */
  lowLatencyBudgetFraction: number;
}

// ─── Stream advisor types (no-stream path) ───────────────────────────────────

/**
 * Recommended stream properties produced by StreamAdvisor when no stream list
 * is available.  The caller uses these values to configure an encoder, request
 * a specific preset from upstream, or decide which stream to open.
 *
 * All values are maximums the network can sustain; the caller may choose lower
 * values freely.  Fields are null when the network is too poor to make a
 * meaningful recommendation (CRITICAL health).
 */
export interface StreamRecommendation {
  /**
   * Maximum recommended bitrate in Kbps.
   * Stays within usable bandwidth with the configured safety margin applied.
   */
  maxBitrateKbps: number;

  /**
   * Recommended target frames per second.
   * Derived from the requirement:
   *   BEST_QUALITY → highest fps the bitrate budget allows (up to 30).
   *   BEST_FPS     → 30 fps target; reduce resolution if bitrate is tight.
   *   LOW_LATENCY  → 15 fps — lower fps reduces encoder buffer size and delay.
   *   AUTO         → scales with network health (EXCELLENT→30, GOOD→25,
   *                  FAIR→20, POOR→15, CRITICAL→5).
   */
  recommendedFps: number;

  /**
   * Recommended resolution tier.
   * Chosen so that typical codec output at that resolution stays within maxBitrateKbps.
   * null when even 160×120 would not fit the budget.
   */
  recommendedResolution: ResolutionTier | null;

  /**
   * The requirement used to produce this recommendation.
   */
  requirement: UserRequirement;

  /** Full QoS analysis that drove the recommendation. */
  networkHealth: NetworkHealthAnalysis;

  /**
   * Human-readable explanation: why these values were chosen and what the
   * caller should do next.
   */
  reason: string;

  /** Unix epoch timestamp (ms) when this recommendation was produced. */
  timestamp: number;
}

/**
 * Named resolution tiers with their typical codec bitrate ranges.
 * Used by StreamAdvisor to map available bandwidth to a resolution label.
 *
 * widthPx / heightPx are the canonical dimensions; typical codec bitrate
 * figures assume H.264 High profile, 25–30 fps, medium motion content.
 */
export interface ResolutionTier {
  /** Short label, e.g. "1080p", "720p", "360p". */
  label: string;

  /** Frame width in pixels. */
  widthPx: number;

  /** Frame height in pixels. */
  heightPx: number;

  /**
   * Minimum bitrate in Kbps typically needed for acceptable quality at this
   * resolution (H.264, 25 fps, medium motion).
   */
  minBitrateKbps: number;

  /**
   * Recommended (good quality) bitrate in Kbps at this resolution.
   */
  recommendedBitrateKbps: number;
}
