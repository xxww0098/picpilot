import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  clientPointToCanvasPoint,
  type Point,
  type ViewTransform,
} from '../../lib/viewportTransform'

export type Tool = 'brush' | 'eraser'

export interface CanvasSize {
  width: number
  height: number
}

export interface SliderAnchor {
  left: number
  bottom: number
}

export interface PinchGesture {
  startTransform: ViewTransform
  startCentroid: Point
  startDistance: number
}

export interface PanGesture {
  pointerId: number
  startPoint: Point
  startTransform: ViewTransform
}

export const DEFAULT_VIEW_TRANSFORM: ViewTransform = { scale: 1, x: 0, y: 0 }

export function getCanvasPoint(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLCanvasElement>): Point {
  return clientPointToCanvasPoint(
    canvas.getBoundingClientRect(),
    { x: event.clientX, y: event.clientY },
    { width: canvas.width, height: canvas.height },
  )
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function centroid(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

export function firstTwoPointers(points: Map<number, Point>): [Point, Point] | null {
  const values = Array.from(points.values())
  return values.length >= 2 ? [values[0], values[1]] : null
}

export function fillWhiteMask(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

export function drawMaskImageToCanvas(maskImage: HTMLImageElement, maskCanvas: HTMLCanvasElement) {
  const maskAspect = maskImage.naturalWidth / maskImage.naturalHeight
  const canvasAspect = maskCanvas.width / maskCanvas.height
  if (Math.abs(maskAspect - canvasAspect) > 0.001) {
    throw new Error('遮罩尺寸与当前图片不一致')
  }

  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!maskCtx) throw new Error('当前浏览器不支持 Canvas')
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
  maskCtx.imageSmoothingEnabled = true
  maskCtx.imageSmoothingQuality = 'high'
  maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height)
}
