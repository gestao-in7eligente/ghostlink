// The Railway wizard's state. It lives outside the dialog: a creation takes minutes and
// keeps going in main when the dialog is closed; reopening shows where it is.
import { create } from 'zustand';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';
import type { RailwayAccount, RailwayCreateRequest, RailwayPending, RailwayProgress } from '../../../shared/railwayTypes.js';
import { errorCodeOf } from '../../i18n/index.js';
import { applyProgress, failCurrent, initialSteps, type StepStates } from './railwayModel.js';

export interface RailwayRun {
  name: string;
  steps: StepStates;
  running: boolean;
  error: AppErrorCode | null;
}

interface RailwayState {
  /** null until loaded. */
  account: RailwayAccount | null;
  pending: RailwayPending | null;
  run: RailwayRun | null;
  load(): Promise<void>;
  connect(token: string): Promise<void>;
  /** Validates a token with Railway and returns its account, without saving it (the "Testar" button). */
  test(token: string): Promise<RailwayAccount>;
  disconnect(): Promise<void>;
  create(req: RailwayCreateRequest, onJoined: (welcome: RendererWelcome) => void): Promise<void>;
  /** Continues the pending creation (after a failure, or one left from an earlier session). */
  resume(onJoined: (welcome: RendererWelcome) => void): Promise<void>;
  discard(): Promise<void>;
  progress(p: RailwayProgress): void;
}

export const useRailwayStore = create<RailwayState>()((set, get) => {
  /** Runs create or resume: progress events fill the list; the end joins the server or shows the error. */
  const drive = async (name: string, steps: StepStates, call: () => Promise<RendererWelcome>, onJoined: (welcome: RendererWelcome) => void) => {
    set({ run: { name, steps, running: true, error: null } });
    try {
      const welcome = await call();
      set({ run: null, pending: null });
      onJoined(welcome);
    } catch (e) {
      const run = get().run;
      set({
        run: { name, steps: failCurrent(run?.steps ?? steps), running: false, error: errorCodeOf(e) },
        pending: await window.ghostlink.railway.pending().catch(() => null),
      });
    }
  };

  return {
    account: null,
    pending: null,
    run: null,
    load: async () => {
      const [account, pending] = await Promise.all([window.ghostlink.railway.status(), window.ghostlink.railway.pending()]);
      set({ account, pending });
    },
    connect: async (token) => set({ account: await window.ghostlink.railway.connect(token) }),
    test: (token) => window.ghostlink.railway.test(token),
    disconnect: async () => set({ account: await window.ghostlink.railway.disconnect() }),
    create: (req, onJoined) => drive(req.name, initialSteps(), () => window.ghostlink.railway.create(req), onJoined),
    resume: (onJoined) => {
      const pending = get().pending;
      if (!pending || get().run?.running) return Promise.resolve();
      return drive(pending.name, initialSteps(pending.step), () => window.ghostlink.railway.resume(), onJoined);
    },
    discard: async () => {
      await window.ghostlink.railway.discard();
      set({ pending: null, run: null });
    },
    progress: (p) => {
      const run = get().run;
      if (run?.running) set({ run: { ...run, steps: applyProgress(run.steps, p) } });
    },
  };
});
