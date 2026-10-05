import { useEffect, useState, type ChangeEvent } from 'react';
import { AVATAR_LIMITS } from '@ghostlink/shared';
import type { PickedFile } from './AvatarCropModal.js';
import { browserCodecs } from './browserCodecs.js';
import { openAvatarFile } from './encodeAvatar.js';

/** What the file input accepts (spec 2026-10-01-foto-de-perfil §2). */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** `text`: a translated line; `code`: an app error code for ErrorText. */
export type PickError = { text: string } | { code: string };

/**
 * The file input's side of "Alterar foto" and "Alterar ícone": a file that is too big or does
 * not decode never opens the crop modal (`unreadable` is shown instead); one that decodes
 * becomes `picked`, with a blob: URL that lives as long as the modal.
 */
export function usePickedImage(unreadable: string) {
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<PickError | null>(null);

  useEffect(() => (picked ? () => URL.revokeObjectURL(picked.url) : undefined), [picked]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again still fires
    setError(null);
    if (!file) return;
    if (file.size === 0 || file.size > AVATAR_LIMITS.inputMaxBytes) {
      setError({ text: unreadable });
      return;
    }
    setOpening(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = await openAvatarFile(bytes, browserCodecs);
      setPicked({ ...image, bytes, url: URL.createObjectURL(new Blob([bytes], { type: image.mime })) });
    } catch {
      setError({ text: unreadable });
    } finally {
      setOpening(false);
    }
  };

  return { picked, close: () => setPicked(null), opening, error, setError, onFile };
}
