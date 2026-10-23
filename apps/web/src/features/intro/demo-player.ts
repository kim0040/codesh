import {
  buildTimeline,
  type Cursors,
  DemoModel,
  type Edit,
  finalState,
  SCENE_HOLD_MS,
  type Scene,
  type TimedOp,
} from "./demo-script.js";

/** What the player drives. DemoEditor implements it on top of CodeMirror. */
export interface PlayerSink {
  /** Resolves when the scene's grammar is ready, so the first character is already highlighted. */
  prepare(index: number): Promise<void>;
  /** Replaces the whole document (a new file opened). */
  reset(index: number, doc: string, cursors: Cursors): void;
  edit(edit: Edit, cursors: Cursors): void;
  moved(cursors: Cursors): void;
}

/**
 * Plays scenes on a virtual clock: operations carry the time they fire at, so pausing only stops
 * the clock and the session continues where it was. When not `running`, scenes are shown finished.
 */
export class DemoPlayer {
  private index = 0;
  private model: DemoModel | null = null;
  private ops: readonly TimedOp[] = [];
  private duration = 0;
  private pos = 0;
  private virtual = 0;
  private targetT = 0;
  private wallStart = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly scenes: readonly Scene[],
    private readonly sink: PlayerSink,
    private readonly onScene: (index: number) => void,
  ) {}

  /** Opens a scene. With the clock stopped it shows the finished file. */
  async open(index: number): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.index = index;
    this.onScene(index);
    await this.sink.prepare(index);
    if (generation !== this.generation || this.disposed) return;
    const scene = this.scenes[index];
    if (!scene) return;
    if (!this.running) {
      const done = finalState(scene);
      this.model = null;
      this.sink.reset(index, done.doc, done.cursors);
      return;
    }
    this.model = new DemoModel(scene.base);
    const timeline = buildTimeline(scene);
    this.ops = timeline.ops;
    this.duration = timeline.duration;
    this.pos = 0;
    this.virtual = 0;
    this.sink.reset(index, this.model.doc, { ...this.model.cursors });
    this.schedule();
  }

  setRunning(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    if (!running) {
      this.freeze();
      return;
    }
    // Resume mid-scene when there is something left to play, else start the scene again.
    if (this.model) this.schedule();
    else void this.open(this.index);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private freeze(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.virtual = Math.min(this.targetT, this.virtual + (performance.now() - this.wallStart));
  }

  private schedule(): void {
    const next = this.pos < this.ops.length ? (this.ops[this.pos]?.t ?? 0) : this.finishAt();
    this.targetT = Math.max(next, this.virtual);
    this.wallStart = performance.now();
    this.timer = setTimeout(() => this.tick(), this.targetT - this.virtual);
  }

  private finishAt(): number {
    return this.duration + SCENE_HOLD_MS;
  }

  private tick(): void {
    this.timer = undefined;
    const model = this.model;
    if (!model) return;
    this.virtual = this.targetT;
    while (this.pos < this.ops.length && (this.ops[this.pos]?.t ?? Infinity) <= this.virtual) {
      const timed = this.ops[this.pos++];
      if (!timed) break;
      const edit = model.apply(timed.op);
      if (edit) this.sink.edit(edit, { ...model.cursors });
      else this.sink.moved({ ...model.cursors });
    }
    if (this.pos >= this.ops.length && this.virtual >= this.finishAt()) {
      void this.open((this.index + 1) % this.scenes.length);
      return;
    }
    this.schedule();
  }
}
