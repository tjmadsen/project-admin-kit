import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { User } from 'firebase/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailBackProvider, useRegisterDetailBack } from './DetailBackContext'
import Layout from './Layout'

const user = {
  email: 'collaborator@example.com',
  displayName: 'Collaborator User',
  photoURL: null,
} as User

function swipe(startX: number, startY: number, endX: number, endY: number) {
  fireEvent.touchStart(document, { touches: [{ clientX: startX, clientY: startY }] })
  fireEvent.touchEnd(document, { changedTouches: [{ clientX: endX, clientY: endY }] })
}

function Detail({ onBack }: { onBack: () => void }) {
  useRegisterDetailBack(true, onBack)
  return <p>Detail content</p>
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: true }))
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('Layout role navigation', () => {
  it('shows collaborators read-only operational views without admin destinations', () => {
    render(<MemoryRouter><Layout user={user} role="collaborator"><p>Content</p></Layout></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Feature Requests' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bugs' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks')
    expect(screen.getByText('Features · Bugs · Tasks · Loops · Activity')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Agent Loops' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Operations' })).not.toBeInTheDocument()
    expect(screen.getByText('Collaborator access')).toBeInTheDocument()
  })

  it('keeps the complete navigation for the administrator', () => {
    render(<MemoryRouter><Layout user={user} role="admin"><p>Content</p></Layout></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Agent Loops' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Operations' })).toBeInTheDocument()
  })

  it('opens and closes the mobile drawer with horizontal swipe gestures', () => {
    const { container } = render(<MemoryRouter><Layout user={user} role="admin"><p>Content</p></Layout></MemoryRouter>)
    const sidebar = container.querySelector('.sidebar')

    swipe(5, 200, 110, 205)
    expect(sidebar).toHaveClass('open')

    swipe(220, 200, 100, 205)
    expect(sidebar).not.toHaveClass('open')
  })

  it('uses the opening edge gesture as back when a detail is registered', () => {
    const onBack = vi.fn()
    const { container } = render(
      <MemoryRouter>
        <DetailBackProvider>
          <Layout user={user} role="admin"><Detail onBack={onBack} /></Layout>
        </DetailBackProvider>
      </MemoryRouter>,
    )

    swipe(5, 200, 110, 205)
    expect(onBack).toHaveBeenCalledOnce()
    expect(container.querySelector('.sidebar')).not.toHaveClass('open')
  })

  it('ignores edge gestures while a modal is active', () => {
    const { container } = render(
      <MemoryRouter><Layout user={user} role="admin"><section role="dialog" aria-modal="true">Modal</section></Layout></MemoryRouter>,
    )

    swipe(5, 200, 110, 205)
    expect(container.querySelector('.sidebar')).not.toHaveClass('open')
  })
})

describe('Layout appearance toggle', () => {
  const radio = (name: string) => within(screen.getByRole('radiogroup', { name: 'Appearance' })).getByRole('radio', { name })

  it('cycles through system, light, and dark, applying and persisting each choice', () => {
    render(<MemoryRouter><Layout user={user} role="collaborator"><p>Content</p></Layout></MemoryRouter>)
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(radio('Light'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(window.localStorage.getItem('project-admin-theme')).toBe('light')
    expect(radio('Light')).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(radio('Dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem('project-admin-theme')).toBe('dark')
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Light')).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(radio('System'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('system')
    expect(window.localStorage.getItem('project-admin-theme')).toBe('system')
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
  })

  it('restores the stored preference when the console loads again', () => {
    window.localStorage.setItem('project-admin-theme', 'dark')
    const { unmount } = render(<MemoryRouter><Layout user={user} role="admin"><p>Content</p></Layout></MemoryRouter>)
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true')
    expect(radio('System')).toHaveAttribute('aria-checked', 'false')
    unmount()
  })
})
