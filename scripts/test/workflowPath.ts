// The workflow tests read each workflow from .github/workflows/.
import { fileURLToPath } from 'node:url';

export function workflowPath(name: string): string {
  return fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url));
}
