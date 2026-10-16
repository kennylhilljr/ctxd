import { describe, expect, it } from "vitest";
import { evaluateStop, initialSessionState, type NudgeConfig, type StopObservation } from "../../src/hooks/nudge.js";

const config: NudgeConfig = {
  enabled: true,
  minMinutesBetween: 30,
  turnsThreshold: 20,
  completionMarkers: ["done"],
};

const MIN = 60_000;

function obs(over: Partial<StopObservation> = {}): StopObservation {
  return {
    now: 100 * MIN,
    head: "abc",
    latestHandoffAt: null,
    lastAssistantMessage: null,
    stopHookActive: false,
    ...over,
  };
}

describe("stop-hook nudge", () => {
  it("nudges when HEAD changed and no recent handoff", () => {
    const d = evaluateStop(initialSessionState("ctxd", "old"), obs(), config);
    expect(d.block).toBe(true);
    expect(d.reason).toContain('scope "ctxd"');
    expect(d.state.nudgePending).toBe(true);
  });

  it("never blocks twice in a row", () => {
    const first = evaluateStop(initialSessionState("ctxd", "old"), obs(), config);
    const second = evaluateStop(first.state, obs({ head: "newer" }), config);
    expect(second.block).toBe(false);
    expect(second.state.nudgePending).toBe(false);
  });

  it("respects the client's stop-hook-active flag", () => {
    const d = evaluateStop(initialSessionState("ctxd", "old"), obs({ stopHookActive: true }), config);
    expect(d.block).toBe(false);
  });

  it("skips when a handoff was written recently", () => {
    const d = evaluateStop(initialSessionState("ctxd", "old"), obs({ latestHandoffAt: 95 * MIN }), config);
    expect(d.block).toBe(false);
  });

  it("rate-limits nudges", () => {
    const first = evaluateStop(initialSessionState("ctxd", "old"), obs(), config);
    const released = evaluateStop(first.state, obs(), config);
    const again = evaluateStop(released.state, obs({ now: 110 * MIN, head: "changed-again" }), config);
    expect(again.block).toBe(false);
    const later = evaluateStop(again.state, obs({ now: 140 * MIN, head: "changed-later" }), config);
    expect(later.block).toBe(true);
  });

  it("nudges on a completion marker even without git changes", () => {
    const d = evaluateStop(
      initialSessionState("ctxd", "abc"),
      obs({ lastAssistantMessage: "All done. Tests pass." }),
      config,
    );
    expect(d.block).toBe(true);
  });

  it("does nothing when disabled", () => {
    const d = evaluateStop(initialSessionState("ctxd", "old"), obs(), { ...config, enabled: false });
    expect(d.block).toBe(false);
  });
});
