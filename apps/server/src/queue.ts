import { v4 as uuid } from "uuid";
import type { Goal } from "@corp-swarm/schema";
import type { Db } from "./db.js";
import {
  countQueuedHandoffs,
  getHandoff,
  insertGoal,
  isPaused,
  listGoals,
  listHandoffs,
  listQueuedHandoffs,
  now,
  setPaused,
  updateGoalStatus,
} from "./db.js";
import { bus } from "./events.js";
import type { Orchestrator } from "./orchestrator.js";

export class SwarmQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private processingRoles = new Set<string>();

  constructor(
    private db: Db,
    private orchestrator: Orchestrator,
    private maxConcurrent: number,
  ) {}

  start(intervalMs = 1500): void {
    if (this.timer) return;
    this.orchestrator.startSilentWatchdog();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    void this.tick();
  }

  stop(): void {
    this.orchestrator.stopSilentWatchdog();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  pause(): void {
    setPaused(this.db, true);
    bus.emit({
      type: "swarm_state",
      paused: true,
      queueDepth: countQueuedHandoffs(this.db),
    });
  }

  resume(): void {
    setPaused(this.db, false);
    bus.emit({
      type: "swarm_state",
      paused: false,
      queueDepth: countQueuedHandoffs(this.db),
    });
    void this.tick();
  }

  async submitCeoGoal(prompt: string, title?: string): Promise<Goal> {
    const goal: Goal = {
      id: uuid(),
      title: title?.trim() || prompt.slice(0, 80),
      prompt,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
    };
    insertGoal(this.db, goal);
    bus.emit({ type: "goal_updated", goal });
    void this.runPlanning(goal.id, prompt);
    return goal;
  }

  private async runPlanning(goalId: string, prompt: string): Promise<void> {
    try {
      let goal = updateGoalStatus(this.db, goalId, "planning");
      bus.emit({ type: "goal_updated", goal });

      await this.orchestrator.planGoal(goalId, prompt);

      goal = updateGoalStatus(this.db, goalId, "executing");
      bus.emit({ type: "goal_updated", goal });
      void this.tick();
    } catch (err) {
      const goal = updateGoalStatus(this.db, goalId, "failed");
      bus.emit({ type: "goal_updated", goal });
      bus.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return;
    if (isPaused(this.db)) return;
    this.tickInFlight = true;
    try {
      const queued = listQueuedHandoffs(this.db);
      for (const handoff of queued) {
        if (this.processingRoles.has(handoff.toRole)) continue;
        if (this.orchestrator.getActiveRunCount() >= this.maxConcurrent) break;

        this.processingRoles.add(handoff.toRole);
        void this.processOne(handoff.id).finally(() => {
          this.processingRoles.delete(handoff.toRole);
        });
      }

      this.maybeCompleteGoals();
    } finally {
      this.tickInFlight = false;
    }
  }

  private async processOne(handoffId: string): Promise<void> {
    const handoff = getHandoff(this.db, handoffId);
    if (!handoff || handoff.status !== "queued") return;
    if (isPaused(this.db)) return;

    try {
      await this.orchestrator.executeHandoff(handoff);
    } catch (err) {
      bus.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      bus.emit({
        type: "swarm_state",
        paused: isPaused(this.db),
        queueDepth: countQueuedHandoffs(this.db),
      });
      this.maybeCompleteGoals();
      void this.tick();
    }
  }

  private maybeCompleteGoals(): void {
    for (const goal of listGoals(this.db)) {
      if (goal.status !== "executing") continue;
      const related = listHandoffs(this.db).filter((h) => h.goalId === goal.id);
      if (related.length === 0) continue;
      const pending = related.some(
        (h) =>
          h.status === "queued" ||
          h.status === "accepted" ||
          h.status === "in_progress",
      );
      if (pending) continue;
      const anyFailed = related.some(
        (h) => h.status === "failed" || h.status === "rejected",
      );
      const updated = updateGoalStatus(
        this.db,
        goal.id,
        anyFailed ? "failed" : "done",
      );
      bus.emit({ type: "goal_updated", goal: updated });
    }
  }
}
