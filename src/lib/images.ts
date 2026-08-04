import type { ChatImage, ImageMediaType } from '../types';

/** What the Anthropic API accepts as an image block. */
const ACCEPTED: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** Enough photos for a flyer plus a couple of screenshots; past that the turn gets expensive. */
export const MAX_IMAGES = 4;

/**
 * Long-edge cap. The model reads a phone photo of a flyer perfectly well at
 * this size, and the image tokens scale with area — a full 12MP upload costs
 * several times as much for no extra detail.
 */
const MAX_EDGE = 1568;

/** Ceiling on the encoded bytes we send, before base64 inflates them by a third. */
const MAX_BYTES = 4 * 1024 * 1024;

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

export function dataUrl(image: ChatImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export class ImageError extends Error {}

/**
 * Turn a picked, pasted or dropped file into something the API will take:
 * a supported format, scaled down if it is bigger than the model can use.
 */
export async function readImage(file: File): Promise<ChatImage> {
  const type = file.type as ImageMediaType;
  const supported = ACCEPTED.includes(type);

  // An animated GIF loses its animation through a canvas, and the model reads
  // the first frame either way — pass it through untouched.
  if (type === 'image/gif') {
    if (file.size > MAX_BYTES) throw new ImageError(`"${file.name}" is too large to send.`);
    return { id: crypto.randomUUID(), name: file.name, mediaType: type, data: await toBase64(file) };
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await decode(url, file.name);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));

    // Already small enough and in a format the API knows: send the original bytes.
    if (scale === 1 && supported && file.size <= MAX_BYTES) {
      return { id: crypto.randomUUID(), name: file.name, mediaType: type, data: await toBase64(file) };
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageError(`"${file.name}" could not be prepared for sending.`);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // PNG keeps screenshot text crisp; anything else is a photo, where JPEG is
    // a fraction of the size at the same readable quality.
    let blob =
      type === 'image/png'
        ? await encode(canvas, 'image/png')
        : await encode(canvas, 'image/jpeg', 0.85);

    if (blob.type === 'image/png' && blob.size > MAX_BYTES) {
      blob = await encode(canvas, 'image/jpeg', 0.85);
    }
    if (blob.size > MAX_BYTES) throw new ImageError(`"${file.name}" is too large to send.`);

    return {
      id: crypto.randomUUID(),
      name: file.name,
      mediaType: blob.type as ImageMediaType,
      data: await toBase64(blob),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decode(url: string, name: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageError(`"${name}" could not be read as an image.`));
    img.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImageError('Could not prepare that image.'))),
      type,
      quality,
    );
  });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      // "data:image/png;base64,XXXX" — the API wants only the payload.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new ImageError('Could not read that file.'));
    reader.readAsDataURL(blob);
  });
}
