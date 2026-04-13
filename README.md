# Dynamic Stream Quality Control

Adaptive stream selector — pure TypeScript logic, zero I/O, zero dependencies.
Drop into any Node.js (or Deno/Bun) streaming system that needs automatic
stream quality switching based on live network conditions.

Works in **four deployment contexts**:

| Context | Streams | API |
|---|---|---|
| Asset ↔ Client / Relay | 2+ streams (substreams) | `UniversalStreamSelector.select()` |
| Asset side / Client side | 1 stream (no substreams) | `UniversalStreamSelector.evaluateSingle()` |
| No stream yet (encoder / client pre-open) | 0 streams | `UniversalStreamSelector.recommend()` |
| Legacy / advanced | 2+ streams | `StreamSelector.select()` (original API, preserved) |

---

## Install

This package is not published to npm. Copy the `src/` directory into your project:

```bash
cp -r path/to/Dynamic-Stream-Quality-Control/src ./src/stream-quality
```

Or publish it to your own private registry:

```bash
npm publish --registry https://your-private-registry
```

Then import directly from the copied path:

```ts
import { UniversalStreamSelector, UserRequirement } from './stream-quality/index.js';
```

---

## Quick Start — Multi-Stream (Asset ↔ Client)

```ts
import {
  UniversalStreamSelector,
  PtzZoomGuard,
  UserRequirement,
  type NetworkQoS,
  type Stream,
} from './stream-quality/index.js';

const selector = new UniversalStreamSelector();
const guard    = new PtzZoomGuard({ settleDurationMs: 3000 });

const streams: Stream[] = [
  { id: 'main',  label: 'Main',       widthPx: 1920, heightPx: 1080, fps: 25, bitrateKbps: 4000, isMainStream: true },
  { id: 'sub1',  label: 'SubStream1', widthPx:  704, heightPx:  576, fps: 25, bitrateKbps:  800 },
  { id: 'sub2',  label: 'SubStream2', widthPx:  352, heightPx:  288, fps: 15, bitrateKbps:  200 },
];

const qos: NetworkQoS = {
  bandwidthKbps:     5000,
  latencyMs:         12,
  jitterMs:          3,
  packetLossPercent: 0,
};

// Wire PTZ zoom commands to the guard (optional):
onPtzZoomCommand(() => guard.onZoomEvent());

// Use UserRequirement instead of UserPriority — works for any stream count:
const result = selector.select(qos, streams, UserRequirement.BEST_QUALITY);

console.log(result.selectedStream.id);    // e.g. "main"
console.log(result.reason);               // human-readable decision
console.log(result.resolvedPriority);     // RESOLUTION_PRIORITY | FPS_PRIORITY
console.log(result.networkWarning);       // true when network is POOR/CRITICAL

if (result.frameDropStrategy?.active) {
  applyFrameDrop(result.frameDropStrategy.dropEveryNthFrame);
}
```

---

## Quick Start — Single Stream (Asset Side / Client Side)

Use this when you have exactly one stream and cannot switch to a lower-quality
variant. The algorithm reports whether the stream fits the network budget and,
when it does not, prescribes frame dropping (depending on the requirement).

```ts
import {
  UniversalStreamSelector,
  UserRequirement,
  type NetworkQoS,
  type Stream,
} from './stream-quality/index.js';

const selector = new UniversalStreamSelector();

const stream: Stream = {
  id: 'main', label: 'Main', widthPx: 1920, heightPx: 1080,
  fps: 25, bitrateKbps: 4000, isMainStream: true,
};

const qos: NetworkQoS = { bandwidthKbps: 1500, latencyMs: 80, jitterMs: 10, packetLossPercent: 1 };

// evaluateSingle — no stream switching, just evaluate + adapt
const result = selector.evaluateSingle(qos, stream, UserRequirement.BEST_FPS);

if (!result.viable) {
  console.warn(result.reason);  // stream exceeds budget
}
if (result.frameDropStrategy?.active) {
  // Drop every Nth frame to stay within bandwidth
  pipeline.setDropEveryNth(result.frameDropStrategy.dropEveryNthFrame);
}
```

You can also call `select()` with a single-element array and get an
`UniversalSelectionResult` (same shape as the multi-stream result):

```ts
const result = selector.select(qos, [stream], UserRequirement.AUTO);
console.log(result.networkWarning); // true when network is degraded
```

---

## Quick Start — No Streams Yet (Encoder / Client Pre-Open)

Use this when you have **no stream at all** and need to know what properties to
request or configure.  The algorithm looks at the live network and user
requirement, then returns a concrete recommendation: max bitrate, target fps,
and the best named resolution tier that fits.

```ts
import {
  UniversalStreamSelector,
  UserRequirement,
  type NetworkQoS,
} from './stream-quality/index.js';

const selector = new UniversalStreamSelector();

const qos: NetworkQoS = { bandwidthKbps: 3000, latencyMs: 40, jitterMs: 8, packetLossPercent: 0 };

// Ask: what should I configure / request given the current network?
const rec = selector.recommend(qos, UserRequirement.BEST_QUALITY);

console.log(rec.recommendedResolution?.label);  // e.g. "720p"
console.log(rec.maxBitrateKbps);                // e.g. 2400
console.log(rec.recommendedFps);                // e.g. 30
console.log(rec.reason);                        // human-readable explanation

// Use the values to configure an encoder before starting:
encoder.configure({
  bitrateKbps: rec.maxBitrateKbps,
  fps:         rec.recommendedFps,
  width:       rec.recommendedResolution?.widthPx  ?? 640,
  height:      rec.recommendedResolution?.heightPx ?? 360,
});

// Or ask a server for the matching profile:
const profile = rec.recommendedResolution?.label ?? '360p';
rtspClient.open(`rtsp://server/stream/${profile}`);
```

You can also use `StreamAdvisor` directly for lower-level control:

```ts
import { StreamAdvisor, UserRequirement } from './stream-quality/index.js';

const advisor = new StreamAdvisor();
const rec     = advisor.recommend(qos, UserRequirement.LOW_LATENCY);

// Inspect available resolution tiers:
advisor.getResolutionTiers().forEach(t =>
  console.log(t.label, t.recommendedBitrateKbps)
);
```

---

## User Requirements

`UserRequirement` is the primary way to express what the user wants. It works
regardless of how many streams are available.

| Requirement | Description | Translates to |
|---|---|---|
| `AUTO` | Algorithm decides based on network health. Best quality on healthy networks; smooth motion on degraded ones. | `RESOLUTION_PRIORITY` (healthy) or `FPS_PRIORITY` (degraded) |
| `BEST_QUALITY` | Highest possible resolution and FPS the network can sustain. No frame dropping. | `RESOLUTION_PRIORITY` |
| `BEST_FPS` | Smoothest motion even at the cost of resolution. Frame dropping applied if needed. | `FPS_PRIORITY` |
| `LOW_LATENCY` | Minimize buffering and glass-to-glass delay. Chooses a stream well within bandwidth so the link stays uncongested. Useful for PTZ and interactive AV. | `RESOLUTION_PRIORITY` with tighter bandwidth budget |

### Network-aware AUTO behaviour

On a **healthy** network (EXCELLENT / GOOD), `AUTO` selects the best quality
stream — same as `BEST_QUALITY`.

On a **degraded** network (FAIR / POOR / CRITICAL), `AUTO` switches to
`FPS_PRIORITY` so the viewer sees consistent motion rather than stuttering
caused by a too-large stream filling and draining buffers.

---

## Network Health and Warnings

Every result includes a `networkHealth` field with:

- `status` — `EXCELLENT | GOOD | FAIR | POOR | CRITICAL`
- `effectiveBandwidthKbps` — bandwidth after applying packet loss, jitter, and latency penalties
- `bandwidthPenaltyFactor` — composite multiplier in [0, 1]
- `issues` — list of detected problems for logging

`UniversalSelectionResult` adds:

- `networkWarning: boolean` — `true` when status is POOR or CRITICAL (or when a single stream is not viable). Use this to trigger a UI warning or alert.
- `resolvedPriority` — which `UserPriority` was used internally (useful for debugging `AUTO` decisions)

`SingleStreamResult` adds:

- `viable: boolean` — whether the stream fits within the usable bandwidth budget
- `frameDropStrategy` — non-null when frame dropping has been prescribed

---

## Priority Modes (original API, preserved)

The original `StreamSelector` with `UserPriority` is fully preserved and
unchanged. Use it directly when you already have the priority resolved or when
integrating with `PtzZoomGuard`:

### `RESOLUTION_PRIORITY`
Always selects the **highest-resolution stream that fits the available bandwidth**.
Never applies frame dropping.

| Bandwidth vs streams | Decision |
|---|---|
| Main stream fits | Use main stream at full quality |
| Main doesn't fit, sub fits | Use highest-res sub-stream that fits |
| Nothing fits | Use lowest-bitrate stream (no frame dropping) |

### `FPS_PRIORITY`
Selects the stream with the **highest frame rate within budget**.
Falls back to frame dropping on the lowest-bitrate stream only when nothing fits.

---

## API Reference

### `UniversalStreamSelector` (new)

```ts
const selector = new UniversalStreamSelector(config?: Partial<UniversalStreamSelectorConfig>);

// Multi-stream selection (1 or more streams)
const result = selector.select(
  qos: NetworkQoS,
  streams: Stream[],
  requirement?: UserRequirement,   // default: AUTO
): UniversalSelectionResult;

// Single-stream evaluation (no switching possible)
const result = selector.evaluateSingle(
  qos: NetworkQoS,
  stream: Stream,
  requirement?: UserRequirement,   // default: AUTO
): SingleStreamResult;

// No streams yet — recommend what to configure / request
const rec = selector.recommend(
  qos: NetworkQoS,
  requirement?: UserRequirement,   // default: AUTO
): StreamRecommendation;
```

**`UniversalStreamSelectorConfig`**

| Field | Default | Description |
|---|---|---|
| `bandwidthSafetyMargin` | `0.20` | Reserve 20 % headroom above selected stream bitrate |
| `minViableFps` | `5` | FPS_PRIORITY fallback threshold |
| `lowLatencyBudgetFraction` | `0.50` | LOW_LATENCY: cap bitrate budget at 50 % of effective bandwidth |

**`UniversalSelectionResult`** (extends `SelectionResult`)

| Field | Type | Description |
|---|---|---|
| `selectedStream` | `Stream` | Stream to switch to |
| `frameDropStrategy` | `FrameDropStrategy \| null` | Frame-drop config if active |
| `networkHealth` | `NetworkHealthAnalysis` | Full QoS analysis |
| `reason` | `string` | Human-readable decision rationale |
| `qualityScore` | `number` | Perceived quality [0, 100] |
| `timestamp` | `number` | Unix ms when decision was made |
| `requirement` | `UserRequirement` | The requirement passed in |
| `resolvedPriority` | `UserPriority` | Priority derived from requirement + network |
| `networkWarning` | `boolean` | true when POOR / CRITICAL |

**`SingleStreamResult`**

| Field | Type | Description |
|---|---|---|
| `stream` | `Stream` | The evaluated stream |
| `viable` | `boolean` | Whether it fits the bandwidth budget |
| `frameDropStrategy` | `FrameDropStrategy \| null` | Prescribed drop strategy (or null) |
| `networkHealth` | `NetworkHealthAnalysis` | Full QoS analysis |
| `reason` | `string` | Human-readable explanation |
| `qualityScore` | `number` | Perceived quality [0, 100] |
| `timestamp` | `number` | Unix ms |

---

### `NetworkAwareAdaptor` (new)

Lower-level class used by `UniversalStreamSelector` for single-stream paths.
Use directly when you want more control:

```ts
const adaptor = new NetworkAwareAdaptor(config?: Partial<StreamSelectorConfig>);
const result  = adaptor.evaluate(
  qos: NetworkQoS,
  stream: Stream,
  requirement?: UserRequirement,
): SingleStreamResult;
```

Frame-drop policy per requirement:

| Requirement | Frame drop applied? |
|---|---|
| `AUTO` | Only when network is POOR or CRITICAL |
| `BEST_QUALITY` | Never — report viable=false instead |
| `BEST_FPS` | Always when stream exceeds budget |
| `LOW_LATENCY` | Never — caller should reduce encoder bitrate |

---

### `StreamAdvisor` (new)

Produces stream property recommendations from QoS alone — no stream list needed.
Used internally by `UniversalStreamSelector.recommend()`; available directly for
lower-level control.

```ts
const advisor = new StreamAdvisor(config?: Partial<StreamSelectorConfig>);

const rec = advisor.recommend(
  qos: NetworkQoS,
  requirement?: UserRequirement,   // default: AUTO
): StreamRecommendation;

advisor.getResolutionTiers(): ResolutionTier[];   // inspect built-in tier table
```

**`StreamRecommendation`**

| Field | Type | Description |
|---|---|---|
| `maxBitrateKbps` | `number` | Maximum safe bitrate for this network |
| `recommendedFps` | `number` | Target fps derived from requirement + health |
| `recommendedResolution` | `ResolutionTier \| null` | Best named resolution tier that fits (`null` if network is critically constrained) |
| `requirement` | `UserRequirement` | The requirement passed in |
| `networkHealth` | `NetworkHealthAnalysis` | Full QoS analysis |
| `reason` | `string` | Human-readable explanation |
| `timestamp` | `number` | Unix ms |

**`ResolutionTier`**

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Short name, e.g. `"1080p"`, `"720p"` |
| `widthPx` / `heightPx` | `number` | Canonical frame dimensions |
| `minBitrateKbps` | `number` | Minimum bitrate for acceptable quality |
| `recommendedBitrateKbps` | `number` | Good-quality bitrate at this resolution |

Built-in tiers (H.264, ~25 fps, medium motion):

| Tier | Resolution | Min Kbps | Recommended Kbps |
|---|---|---|---|
| 4K | 3840×2160 | 15 000 | 25 000 |
| 1440p | 2560×1440 | 8 000 | 12 000 |
| 1080p | 1920×1080 | 3 000 | 5 000 |
| 720p | 1280×720 | 1 500 | 2 500 |
| 480p | 854×480 | 600 | 1 000 |
| 360p | 640×360 | 300 | 500 |
| 240p | 426×240 | 150 | 250 |
| 160p | 284×160 | 64 | 128 |

**`recommendedFps` per requirement and network health:**

| Requirement | EXCELLENT | GOOD | FAIR | POOR | CRITICAL |
|---|---|---|---|---|---|
| `AUTO` | 30 | 25 | 20 | 15 | 5 |
| `BEST_QUALITY` | 30 | 30 | 30 | 30 | 30 |
| `BEST_FPS` | 30 | 30 | 30 | 30 | 30 |
| `LOW_LATENCY` | 15 | 15 | 15 | 15 | 15 |

---

### `StreamSelector` (original, preserved)

```ts
const selector = new StreamSelector(config?: Partial<StreamSelectorConfig>);
const result   = selector.select(qos: NetworkQoS, streams: Stream[], priority: UserPriority): SelectionResult;
```

**`StreamSelectorConfig`**

| Field | Default | Description |
|---|---|---|
| `bandwidthSafetyMargin` | `0.20` | Reserve 20 % headroom above selected stream bitrate |
| `minViableFps` | `5` | FPS_PRIORITY fallback threshold |

---

### `PtzZoomGuard` (original, preserved)

```ts
const guard = new PtzZoomGuard(config?: PtzZoomGuardConfig);
guard.onZoomEvent();                                      // call on each zoom command
const p = guard.getEffectivePriority(userPreference);    // returns UserPriority
guard.release();                                          // force-release the lock
guard.isLocked;                                           // boolean
```

Locks the priority to `RESOLUTION_PRIORITY` for `settleDurationMs` (default 3 s)
after each zoom command, preventing resolution downgrade during the bitrate spike
that zoom causes.

Compatible with `UniversalStreamSelector` via `UserPriority`:

```ts
// Convert guard output to UserRequirement when using UniversalStreamSelector
const lockedPriority = guard.getEffectivePriority(UserPriority.RESOLUTION_PRIORITY);
// if locked, use BEST_QUALITY; otherwise use the user's actual requirement
const requirement = guard.isLocked ? UserRequirement.BEST_QUALITY : UserRequirement.AUTO;
const result = selector.select(qos, streams, requirement);
```

---

### `QoSAnalyzer` (advanced)

```ts
const analyzer = new QoSAnalyzer();
const health   = analyzer.analyze(qos: NetworkQoS): NetworkHealthAnalysis;
```

Applies multiplicative penalty factors for packet loss, jitter, and latency to
derive `effectiveBandwidthKbps`.

---

## Bandwidth Measurement

The module does not measure bandwidth — that is the caller's responsibility.
A simple approach using MediaMTX `bytesReceived` counters:

```ts
// Poll every ~3 s; delta gives kbps
const bytes   = mtxPath.bytesReceived;
const elapsed = (Date.now() - lastTime) / 1000;
const kbps    = Math.round((bytes - lastBytes) * 8 / 1000 / elapsed);
```

Use the **maximum** bitrate across all active streams as the bandwidth estimate —
the link is carrying at least that much, so it sets a safe lower bound.

---

## Integration Notes

- All methods are **synchronous** — safe to call from any async context.
- No global state — each instance is independent.
- `Stream.fps = 0` and `Stream.widthPx = 0` are valid (probe not yet available);
  the selector uses `bitrateKbps` as a quality proxy automatically.
- `isMainStream` should be set on exactly one stream (the highest-resolution one).
  If omitted, it is inferred from pixel count.
- `UniversalStreamSelector.select()` with a single-element array returns the same
  `UniversalSelectionResult` shape as the multi-stream path — no special casing needed.

---

## Files

```
src/
  index.ts                   — public exports
  types.ts                   — all interfaces and enums
  StreamSelector.ts          — original multi-stream selection logic (preserved)
  QoSAnalyzer.ts             — bandwidth penalty model
  FrameDropCalculator.ts     — periodic frame-drop pattern calculator
  PtzZoomGuard.ts            — PTZ zoom priority override
  NetworkAwareAdaptor.ts     — single-stream network-aware adaptation (new)
  StreamAdvisor.ts           — stream property recommendation, no streams needed (new)
  UniversalStreamSelector.ts — unified entry point for all contexts (new)
```
