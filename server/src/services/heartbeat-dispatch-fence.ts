export type HeartbeatDispatchAdmission<T> =
  | { admitted: true; value: T }
  | { admitted: false; reason: "supervisor_fence" };

export type HeartbeatDispatchFenceSnapshot = {
  fenced: boolean;
  activeAdmissions: number;
  leaseExpiresAt: string | null;
};

export class HeartbeatDispatchFence {
  private fenced = false;
  private activeAdmissions = 0;
  private activeLeaseToken: string | null = null;
  private leaseExpiresAt: number | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private onLeaseExpired: (() => void | Promise<void>) | null = null;
  private drainWaiters = new Set<() => void>();

  snapshot(): HeartbeatDispatchFenceSnapshot {
    return {
      fenced: this.fenced,
      activeAdmissions: this.activeAdmissions,
      leaseExpiresAt: this.leaseExpiresAt ? new Date(this.leaseExpiresAt).toISOString() : null,
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

  private armLeaseExpiry(leaseToken: string, leaseTtlMs: number) {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseExpiresAt = Date.now() + Math.max(1, leaseTtlMs);
    this.leaseTimer = setTimeout(() => {
      if (this.activeLeaseToken !== leaseToken) return;
      const onLeaseExpired = this.onLeaseExpired;
      this.fenced = false;
      this.activeLeaseToken = null;
      this.leaseExpiresAt = null;
      this.leaseTimer = null;
      this.onLeaseExpired = null;
      if (onLeaseExpired) void Promise.resolve(onLeaseExpired()).catch(() => undefined);
    }, Math.max(1, leaseTtlMs));
    this.leaseTimer.unref?.();
  }

  async enter(
    leaseToken: string,
    leaseTtlMs: number,
    onLeaseExpired?: () => void | Promise<void>,
  ): Promise<HeartbeatDispatchFenceSnapshot> {
    if (!leaseToken) throw new Error("dispatch fence lease token is required");
    if (this.fenced && this.activeLeaseToken !== leaseToken) {
      throw new Error("dispatch fence is already held by another lease");
    }
    this.fenced = true;
    this.activeLeaseToken = leaseToken;
    this.onLeaseExpired = onLeaseExpired ?? null;
    this.armLeaseExpiry(leaseToken, leaseTtlMs);
    if (this.activeAdmissions > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
    }
    return this.snapshot();
  }

  isLeaseValid(leaseToken: string) {
    return Boolean(leaseToken) && this.fenced && this.activeLeaseToken === leaseToken;
  }

  renew(leaseToken: string, leaseTtlMs: number): HeartbeatDispatchFenceSnapshot {
    if (!this.isLeaseValid(leaseToken)) {
      throw new Error("dispatch fence lease token is invalid");
    }
    this.armLeaseExpiry(leaseToken, leaseTtlMs);
    return this.snapshot();
  }

  exit(leaseToken: string): HeartbeatDispatchFenceSnapshot {
    if (!this.isLeaseValid(leaseToken)) {
      throw new Error("dispatch fence lease token is invalid");
    }
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.fenced = false;
    this.activeLeaseToken = null;
    this.leaseExpiresAt = null;
    this.onLeaseExpired = null;
    return this.snapshot();
  }
}

export const heartbeatDispatchFence = new HeartbeatDispatchFence();
