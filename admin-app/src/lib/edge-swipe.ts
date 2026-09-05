export interface SwipeGesture {
  startX: number
  startY: number
  endX: number
  endY: number
}

export type SwipeResult = 'open' | 'close' | 'none'
export type EdgeSwipeAction = 'back' | SwipeResult

export const EDGE_THRESHOLD = 32
export const SWIPE_MIN_X = 50
export const HORIZONTAL_DOMINANCE = 1

export function detectSidebarSwipe(gesture: SwipeGesture, sidebarOpen: boolean): SwipeResult {
  const dx = gesture.endX - gesture.startX
  const dy = gesture.endY - gesture.startY

  if (Math.abs(dx) < SWIPE_MIN_X) return 'none'
  if (Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_DOMINANCE) return 'none'

  if (!sidebarOpen) return gesture.startX <= EDGE_THRESHOLD && dx > 0 ? 'open' : 'none'
  return dx < 0 ? 'close' : 'none'
}

export function resolveEdgeSwipeAction(result: SwipeResult, detailOpen: boolean): EdgeSwipeAction {
  return result === 'open' && detailOpen ? 'back' : result
}
