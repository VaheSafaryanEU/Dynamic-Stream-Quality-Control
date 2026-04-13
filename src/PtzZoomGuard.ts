// ─────────────────────────────────────────────────────────────────────────────
// PtzZoomGuard.ts  –  Priority override for PTZ zoom events
// ─────────────────────────────────────────────────────────────────────────────

import { UserPriority, PtzZoomGuardConfig } from './types.js';

/**
 * PtzZoomGuard
 * ────────────
 * A stateful module that temporarily forces RESOLUTION_PRIORITY whenever a
 * PTZ zoom event is active, preventing the stream selector from downgrading
 * to a lower-resolution substream during the transient bitrate spike that
 * every zoom operation causes.
 *
 * Why this is needed
 * ──────────────────
 * When a PTZ camera zooms, nearly every pixel changes between frames.
 * The encoder produces massively oversized P-frames (3–5× normal bitrate).
 * This burst fills router buffers, raises RTT, and causes packet loss.
 * The QoS penalty model correctly detects all three signals and reduces
 * usable bandwidth — which would normally trigger a resolution downgrade.
 *
 * That downgrade is exactly wrong: the user zoomed in to see fine detail.
 * This guard intercepts the priority decision and forces RESOLUTION_PRIORITY
 * so the algorithm keeps the best-resolution stream.
 *
 * Usage
 * ──────
 * ```ts
 * import { PtzZoomGuard, StreamSelector, UserPriority } from 'dynamic-stream-quality-control';
 *
 * const guard    = new PtzZoomGuard({ settleDurationMs: 3000 });
 * const selector = new StreamSelector();
 *
 * // Wire to whatever delivers PTZ commands in your system:
 * onPtzZoomCommand(() => guard.onZoomEvent());
 *
 * // Inside your adaptation loop (every 1–3 s):
 * const priority = guard.getEffectivePriority(UserPriority.FPS_PRIORITY);
 * const result   = selector.select(qos, streams, priority);
 * ```
 */
export class PtzZoomGuard {
  private readonly settleDurationMs: number;
  private readonly onLockCb?:    () => void;
  private readonly onReleaseCb?: () => void;

  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private _locked = false;

  constructor(config: PtzZoomGuardConfig = {}) {
    this.settleDurationMs = config.settleDurationMs ?? 3_000;
    this.onLockCb         = config.onLock;
    this.onReleaseCb      = config.onRelease;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Signal that a zoom increment has occurred.
   * Call on every PTZ zoom command — single clicks, each tick of a joystick
   * hold, or each frame of a continuous zoom. The settle timer resets on every
   * call so the lock persists for the full duration plus the settling window.
   */
  onZoomEvent(): void {
    if (!this._locked) {
      this._locked = true;
      this.onLockCb?.();
    }

    if (this.settleTimer !== null) clearTimeout(this.settleTimer);

    this.settleTimer = setTimeout(() => {
      this._locked     = false;
      this.settleTimer = null;
      this.onReleaseCb?.();
    }, this.settleDurationMs);
  }

  /**
   * Returns the priority to pass to StreamSelector.select().
   * Returns RESOLUTION_PRIORITY while a zoom is active/settling;
   * otherwise returns the user's preference unchanged.
   */
  getEffectivePriority(userPreference: UserPriority): UserPriority {
    return this._locked ? UserPriority.RESOLUTION_PRIORITY : userPreference;
  }

  /** Whether the guard is currently overriding the user's priority. */
  get isLocked(): boolean {
    return this._locked;
  }

  /**
   * Release the lock immediately, cancelling any active settle timer.
   * Use this when the camera session ends or the user explicitly cancels zoom.
   */
  release(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this._locked) {
      this._locked = false;
      this.onReleaseCb?.();
    }
  }
}
