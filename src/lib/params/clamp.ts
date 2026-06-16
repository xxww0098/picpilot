/** 把 value 夹在 [min, max] 区间内。全项目统一的钳制工具，避免各处重复定义。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
