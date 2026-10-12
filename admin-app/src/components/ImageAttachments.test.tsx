import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentGallery } from './ImageAttachments'

const urls = [
  'https://example.com/first.png',
  'https://example.com/report.pdf',
  'https://example.com/second.png',
  'https://example.com/third.jpg',
]

describe('AttachmentGallery', () => {
  it('mounts the preview at the viewport level and closes it from there', () => {
    const view = render(<div data-testid="gallery-scroll-container"><AttachmentGallery urls={[urls[0]]} /></div>)

    fireEvent.click(screen.getByRole('button', { name: 'Attachment 1' }))

    const dialog = screen.getByRole('dialog', { name: 'Image preview' })
    expect(dialog.parentElement).toBe(document.body)
    expect(view.container).not.toContainElement(dialog)

    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }))
    expect(screen.queryByRole('dialog', { name: 'Image preview' })).not.toBeInTheDocument()
  })

  it('navigates only images by click and keyboard with clear boundary states', () => {
    render(<AttachmentGallery urls={urls} label="Gallery attachment" />)

    expect(screen.getByRole('link', { name: 'Open or download report.pdf' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Gallery attachment 1' }))

    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()
    expect(screen.getByText('Image 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Gallery attachment 1 full size' })).toHaveAttribute('src', urls[0])
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Gallery attachment 3 full size' })).toHaveAttribute('src', urls[2])

    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    expect(screen.getByText('Image 1 of 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText('Image 3 of 3')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Gallery attachment 4 full size' })).toHaveAttribute('src', urls[3])
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled()

    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText('Image 3 of 3')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Image preview' })).not.toBeInTheDocument()
  })

  it('removes its keyboard listener when the preview closes', () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    render(<AttachmentGallery urls={urls} />)

    fireEvent.click(screen.getByRole('button', { name: 'Attachment 1' }))
    const keydownHandler = addListener.mock.calls.find(([type]) => type === 'keydown')?.[1]
    expect(keydownHandler).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }))
    expect(removeListener.mock.calls.some(([type, listener]) => type === 'keydown' && listener === keydownHandler)).toBe(true)

    addListener.mockRestore()
    removeListener.mockRestore()
  })
})
