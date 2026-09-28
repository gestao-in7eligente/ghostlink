import { useEffect } from 'react';
import { useHostStore } from './hostStore.js';

/** Keeps the host store in step with the main process: first a snapshot, then every change. */
export function useHostStatusSync(attempt: number): void {
  useEffect(() => {
    const api = window.ghostlink;
    const { dispatch } = useHostStore.getState();
    const off = api.onHostStatus((status) => dispatch({ type: 'status', status }));
    let alive = true;
    api.host.status().then(
      (status) => alive && dispatch({ type: 'status', status }),
      () => {}, // the next event brings it
    );
    return () => {
      alive = false;
      off();
    };
  }, [attempt]);
}
