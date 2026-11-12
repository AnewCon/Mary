import { Failure } from './exchange';

const scale = 10n ** 12n;

export function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,26}(\.\d{1,12})?$/.test(value)) throw new Failure('INVALID_DECIMAL');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(whole + fraction.padEnd(12, '0'));
  return value.startsWith('-') ? -units : units;
}

export function positive(value: unknown): bigint {
  const n = decimal(value);
  if (n <= 0n) throw new Failure('POSITIVE_AMOUNT_REQUIRED');
  return n;
}

export function text(n: bigint): string {
  const magnitude = n < 0n ? -n : n;
  const fraction = (magnitude % scale).toString().padStart(12, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${magnitude / scale}${fraction ? '.' + fraction : ''}`;
}

export const mul = (a: bigint, b: bigint) => a * b / scale;
export const div = (a: bigint, b: bigint) => a * scale / b;
export const bps = (a: bigint, points: number) => a * BigInt(points) / 10000n;
export const abs = (a: bigint) => a < 0n ? -a : a;
export const min = (a: bigint, b: bigint) => a < b ? a : b;
export const max = (a: bigint, b: bigint) => a > b ? a : b;
export const roundDown = (a: bigint, step: bigint) => a / step * step;
export const roundUp = (a: bigint, step: bigint) => (a + step - 1n) / step * step;
