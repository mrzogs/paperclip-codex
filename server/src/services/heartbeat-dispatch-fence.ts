export type HeartbeatDispatchAdmission<T> =
  | { admitted: true; value: T }
  | { admitted: false; reason: "supervisor_fence" };

export type HeartbeatDispatchFenceSnapshot = {
  fenced: boolean;
  activeAdmissions: number;
};

export class HeartbeatDispatchFence {
  private fenced = false;
  private activeAdmissions = 0;
  private drainWaiters = new Set<() => void>();

  snapshot(): HeartbeatDispatchFenceSnapshot {
    return {
      fenced: this.fenced,
      activeAdmissions: this.activeAdmissions,
    };
  }

  async run<T>(work: () => Promise<T>): Promise<HeartbeatDispatchAdmission<T>> {
    // JavaScript cannot interleave between this check and increment. Once an
    // admission is counted, enter() must wait for it to finish claiming and
    // launching (or declining) the queued run before acknowledging the fence.
    if (this.fenced) return { admitted: false, reason: "supervisor_fence" };
    this.activeAdmissions += 1;
    try {
      return { admitted: true, value: await work() };
    } finally {
      this.activeAdmissions -= 1;
      if (this.activeAdmissions === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    }
  }

  async enter(): Promise<HeartbeatDispatchFenceSnapshot> {
    this.fenced = true;
    if (this.activeAdmissions > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
    }
    return this.snapshot();
  }

  exit(): HeartbeatDispatchFenceSnapshot {
    this.fenced = false;
    return this.snapshot();
  }
}

export const heartbeatDispatchFence = new HeartbeatDispatchFence();
