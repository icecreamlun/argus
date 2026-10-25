/** Fast Euclidean norms (Math.hypot is variadic and several times slower in V8 hot loops). */
export function hyp(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}
export function hyp3(a: number, b: number, c: number): number {
  return Math.sqrt(a * a + b * b + c * c);
}
