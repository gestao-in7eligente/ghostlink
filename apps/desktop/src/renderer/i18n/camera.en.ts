// The camera in calls (v0.2.3): same keys as camera.pt-BR.ts.
import type { camera as ptBR } from './camera.pt-BR.js';

export const camera: Record<keyof typeof ptBR, string> = {
  'voice.camera.on': 'Turn on camera',
  'voice.camera.off': 'Turn off camera',
  'voice.camera.noPermission': "You don't have permission to use your camera in this channel.",
  'voice.camera.options': 'Video options',
  'voice.camera.device': 'Camera',
  'voice.camera.live': 'Camera on',
  'voice.notice.cameraUnavailable': 'Could not use the camera. Check the permission and the chosen device.',
};
