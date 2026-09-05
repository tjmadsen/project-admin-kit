import { describe, expect, it } from 'vitest'
import { detectSidebarSwipe, EDGE_THRESHOLD, resolveEdgeSwipeAction, SWIPE_MIN_X } from './edge-swipe'

const swipe = (startX: number, startY: number, dx: number, dy: number) => ({
  startX,
  startY,
  endX: startX + dx,
  endY: startY + dy,
})

describe('detectSidebarSwipe', () => {
  it('opens for a horizontal right swipe that starts at the left edge', () => {
    expect(detectSidebarSwipe(swipe(5, 200, 120, 5), false)).toBe('open')
    expect(detectSidebarSwipe(swipe(EDGE_THRESHOLD, 200, 100, 0), false)).toBe('open')
  })

  it('does not open for content swipes away from the edge', () => {
    expect(detectSidebarSwipe(swipe(EDGE_THRESHOLD + 1, 200, 120, 5), false)).toBe('none')
    expect(detectSidebarSwipe(swipe(5, 200, -120, 0), false)).toBe('none')
  })

  it('ignores short and vertically dominant gestures', () => {
    expect(detectSidebarSwipe(swipe(5, 200, SWIPE_MIN_X - 1, 0), false)).toBe('none')
    expect(detectSidebarSwipe(swipe(5, 200, 60, 200), false)).toBe('none')
  })

  it('closes an open drawer with a horizontal left swipe from anywhere', () => {
    expect(detectSidebarSwipe(swipe(250, 200, -150, 10), true)).toBe('close')
    expect(detectSidebarSwipe(swipe(120, 200, 90, 0), true)).toBe('none')
    expect(detectSidebarSwipe(swipe(250, 200, -60, 200), true)).toBe('none')
  })
})

describe('resolveEdgeSwipeAction', () => {
  it('uses the opening edge swipe as back while a detail is open', () => {
    expect(resolveEdgeSwipeAction('open', true)).toBe('back')
    expect(resolveEdgeSwipeAction('open', false)).toBe('open')
  })

  it('does not rewrite close or ignored gestures', () => {
    expect(resolveEdgeSwipeAction('close', true)).toBe('close')
    expect(resolveEdgeSwipeAction('none', true)).toBe('none')
  })
})
