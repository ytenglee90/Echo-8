import type { CameraState } from '../../protocols/canvas.ts';

export interface CanvasPanSession {
  pointerId: number;
  interactionSessionId: string;
  pointerX: number;
  pointerY: number;
  origin: CameraState;
  latest: CameraState;
}

/**
 * Owns the single active pointer-pan session and its identity. Keeping this
 * outside the React surface prevents asynchronous begin failures from clearing
 * a newer gesture and makes pointer ownership explicit.
 */
export class CanvasPanSessionController {
  private activeSession?: CanvasPanSession;
  private sequence = 0;

  get active(): boolean {
    return this.activeSession !== undefined;
  }

  begin(
    pointerId: number,
    pointerX: number,
    pointerY: number,
    camera: CameraState,
  ): CanvasPanSession | undefined {
    if (this.activeSession) return undefined;
    const interactionSessionId = `canvas:pan:${pointerId}:${++this.sequence}`;
    this.activeSession = {
      pointerId,
      interactionSessionId,
      pointerX,
      pointerY,
      origin: camera,
      latest: camera,
    };
    return this.activeSession;
  }

  move(pointerId: number, pointerX: number, pointerY: number): CameraState | undefined {
    const session = this.activeSession;
    if (!session || session.pointerId !== pointerId) return undefined;
    session.latest = {
      ...session.origin,
      x: session.origin.x + pointerX - session.pointerX,
      y: session.origin.y + pointerY - session.pointerY,
    };
    return session.latest;
  }

  release(pointerId: number): CanvasPanSession | undefined {
    if (this.activeSession?.pointerId !== pointerId) return undefined;
    return this.clear();
  }

  reject(interactionSessionId: string): CanvasPanSession | undefined {
    if (this.activeSession?.interactionSessionId !== interactionSessionId) return undefined;
    return this.clear();
  }

  cancel(): CanvasPanSession | undefined {
    return this.clear();
  }

  private clear(): CanvasPanSession | undefined {
    const session = this.activeSession;
    this.activeSession = undefined;
    return session;
  }
}
