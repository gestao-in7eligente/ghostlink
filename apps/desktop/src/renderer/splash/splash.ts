// The update splash page (main/updateSplash.ts): shows the view main sends, already translated,
// and offers "Open without updating" when main says so. No React: it opens before everything else.
import './splash.css';
import type { SplashApi, SplashView } from '../../shared/splash.js';

const api = (window as Window & { ghostlinkSplash?: SplashApi }).ghostlinkSplash;
const status = document.getElementById('status') as HTMLParagraphElement;
const progress = document.getElementById('progress') as HTMLProgressElement;
const skip = document.getElementById('skip') as HTMLButtonElement;

function render(view: SplashView): void {
  document.documentElement.lang = view.lang;
  status.textContent = view.status;
  progress.hidden = view.percent === null;
  progress.value = view.percent ?? 0;
  skip.hidden = view.skip === null;
  skip.textContent = view.skip ?? '';
}

skip.addEventListener('click', () => {
  skip.disabled = true;
  api?.skip();
});
api?.onView(render);
