import { randomUUID } from 'node:crypto';

const uuidHex = /^[0-9a-f]{32}$/;

export type IdPrefix = 'thr' | 'run';

export function toPublicId(prefix: IdPrefix, uuid: string): string {
  return `${prefix}_${uuid.replaceAll('-', '')}`;
}

export function fromPublicId(prefix: IdPrefix, publicId: string): string | null {
  const start = `${prefix}_`;
  if (!publicId.startsWith(start)) return null;
  const hex = publicId.slice(start.length);
  if (!uuidHex.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newThreadId(): string {
  return toPublicId('thr', randomUUID());
}
