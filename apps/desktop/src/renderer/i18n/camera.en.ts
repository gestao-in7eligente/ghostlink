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

  'voice.settings.video': 'Video',
  'voice.settings.cameraPreview': 'Camera preview',
  'voice.settings.cameraPreviewOff': 'Your camera shows here.',
  'voice.settings.cameraTest': 'Test camera',
  'voice.settings.cameraTestStop': 'Stop test',
  'voice.settings.cameraInCall': "That's the camera you have on in the call.",
  'voice.settings.noCamera': 'No camera found.',
  'voice.settings.cameraQuality': 'Camera quality',
  'voice.settings.cameraQualityDefault': 'Default',
  'voice.settings.cameraQualityHint': 'Viewers get a smaller version when the tile is small or their connection gets worse.',
};
