// The call's mini window while I share my screen (spec 2026-10-02-janelinha-da-chamada-design.md):
// the main window's page opens it with window.open('', CALL_WINDOW_NAME) and draws into it; main
// allows that one popup and nothing else. Shared by main and the renderer.

/** The popup's frame name: the only window.open main lets through. */
export const CALL_WINDOW_NAME = 'ghostlink-call';

/** About Google Meet's picture-in-picture while presenting. */
export const CALL_WINDOW_SIZE = { width: 320, height: 380 } as const;
