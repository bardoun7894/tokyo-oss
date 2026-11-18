import type { SharedContext } from "./types";
import type { PrayerTimes, NextPrayer, TimeSlot } from "../types";
import { localToday } from "../utils";

/**
 * Shared cross-agent context provider.
 * Caches prayer times, user state, and provides them to all agents.
 */
export class SharedContextProvider {
  private cachedPrayer: PrayerTimes | null = null;
  private cachedNextPrayer: NextPrayer | null = null;
  private cachedWorkWindows: TimeSlot[] = [];
  private lastPrayerRefresh = 0;

  /** Refresh prayer data — called by deen agent or at startup */
  async refreshPrayer(): Promise<void> {
    try {
      const { getTodayPrayerTimes, getNextPrayer, getWorkWindows } = await import("../prayer");
      this.cachedPrayer = await getTodayPrayerTimes();
      this.cachedNextPrayer = await getNextPrayer();
      this.cachedWorkWindows = await getWorkWindows();
      this.lastPrayerRefresh = Date.now();
    } catch (err) {
      console.error("[SharedContext] Prayer refresh error:", err);
    }
  }

  /** Get full shared context */
  async getContext(): Promise<SharedContext> {
    // Refresh prayer data if stale (>1 hour)
    if (Date.now() - this.lastPrayerRefresh > 3600_000) {
      await this.refreshPrayer();
    }

    // Get current user state
    let userState;
    try {
      const { getCurrentState } = await import("../state");
      userState = getCurrentState();
    } catch {
      userState = { state: "idle" as const, source: "auto" as const, setAt: new Date().toISOString() };
    }

    return {
      prayerTimes: this.cachedPrayer,
      nextPrayer: this.cachedNextPrayer,
      workWindows: this.cachedWorkWindows,
      userState,
      today: localToday(),
    };
  }

  /** Update prayer cache directly (called when deen agent fetches new times) */
  setPrayerData(times: PrayerTimes, next: NextPrayer, windows: TimeSlot[]): void {
    this.cachedPrayer = times;
    this.cachedNextPrayer = next;
    this.cachedWorkWindows = windows;
    this.lastPrayerRefresh = Date.now();
  }
}
