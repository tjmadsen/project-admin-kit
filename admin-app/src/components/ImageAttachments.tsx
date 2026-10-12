import { useEffect, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_MB, documentKind } from '../lib/attachments'

export function AttachmentPicker({ files, disabled, compact = false, onAdd, onRemove }: { files: File[]; disabled?: boolean; compact?: boolean; onAdd: (files: File[]) => void; onRemove: (index: number) => void }) {
  const [dragging, setDragging] = useState(false)
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    if (!disabled) onAdd(Array.from(event.dataTransfer.files))
  }
  return <div className={`attachment-picker ${compact ? 'compact' : ''}`}>
    {files.length > 0 && <div className="pending-attachments">{files.map((file, index) => <LocalAttachment key={`${file.name}-${file.size}-${file.lastModified}-${index}`} file={file} index={index} onRemove={onRemove} />)}</div>}
    <label className={`attachment-dropzone ${dragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''}`} title={compact ? `Attach images, PDF, CSV, or TXT · up to ${MAX_ATTACHMENT_COUNT} files · ${MAX_ATTACHMENT_MB} MB each` : undefined} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={drop}>
      <span>▧</span><strong>{files.length ? 'Add more attachments' : 'Drop or choose attachments'}</strong><small>Images, PDF, CSV, or TXT · up to {MAX_ATTACHMENT_COUNT} files · {MAX_ATTACHMENT_MB} MB each</small>
      <input aria-label="Choose attachments" type="file" accept={ATTACHMENT_ACCEPT} multiple disabled={disabled} onChange={(event) => { if (event.target.files) onAdd(Array.from(event.target.files)); event.target.value = '' }} />
    </label>
  </div>
}

function LocalAttachment({ file, index, onRemove }: { file: File; index: number; onRemove: (index: number) => void }) {
  const isImage = file.type.startsWith('image/')
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!isImage) { setUrl(''); return }
    const nextUrl = URL.createObjectURL(file)
    setUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [file, isImage])
  return <div className={`pending-attachment ${isImage ? 'image' : 'document'}`}>
    {isImage ? <img src={url} alt={file.name || `Pending attachment ${index + 1}`} /> : <span className="attachment-type" aria-hidden="true">{documentKind(file.name)?.toUpperCase()}</span>}
    <button type="button" aria-label={`Remove ${file.name || `attachment ${index + 1}`}`} onClick={() => onRemove(index)}>×</button>
    <small>{file.name || 'Pasted image'}</small>
  </div>
}

export function attachmentNameFromUrl(url: string) {
  try {
    const parsed = new URL(url)
    const encodedPath = parsed.pathname.split('/o/').at(-1) || parsed.pathname
    const storedName = decodeURIComponent(encodedPath).split('/').at(-1) || 'Attachment'
    return storedName.replace(/^(?:[0-9a-f]{8}-[0-9a-f-]{27}|\d{10,}-\d+)-/i, '')
  } catch {
    return decodeURIComponent(url.split('?')[0].split('/').at(-1) || 'Attachment')
  }
}

export function AttachmentGallery({ urls, label = 'Attachment' }: { urls: string[] | undefined; label?: string }) {
  const images = (urls || []).flatMap((url, attachmentIndex) => documentKind(attachmentNameFromUrl(url)) ? [] : [{ url, attachmentIndex }])
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const active = activeIndex == null ? undefined : images[activeIndex]
  useEffect(() => {
    if (activeIndex == null) return
    if (activeIndex >= images.length) { setActiveIndex(null); return }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveIndex(null)
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setActiveIndex((current) => current == null || current === 0 ? current : current - 1)
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setActiveIndex((current) => current == null || current >= images.length - 1 ? current : current + 1)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeIndex, images.length])
  if (!urls?.length) return null
  let imageIndex = 0
  return <>
    <div className="attachment-gallery">{urls.map((url, index) => {
      const name = attachmentNameFromUrl(url)
      const kind = documentKind(name)
      const galleryIndex = kind ? null : imageIndex++
      return kind
        ? <a className="attachment-file" href={url} target="_blank" rel="noreferrer" download={name} key={`${url}-${index}`} aria-label={`Open or download ${name}`}>
            <span className="attachment-type" aria-hidden="true">{kind.toUpperCase()}</span><span><strong>{name}</strong><small>Open or download</small></span><b aria-hidden="true">↗</b>
          </a>
        : <button className="attachment-image" type="button" key={`${url}-${index}`} onClick={() => setActiveIndex(galleryIndex)}><img src={url} alt={`${label} ${index + 1}`} loading="lazy" /></button>
    })}</div>
    {active && activeIndex != null && createPortal(<div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveIndex(null) }}>
      <button className="image-lightbox-close" type="button" aria-label="Close image preview" onClick={() => setActiveIndex(null)}>×</button>
      {images.length > 1 && <>
        <button className="image-lightbox-nav previous" type="button" aria-label="Previous image" disabled={activeIndex === 0} onClick={() => setActiveIndex((current) => current == null ? current : Math.max(0, current - 1))}>‹</button>
        <button className="image-lightbox-nav next" type="button" aria-label="Next image" disabled={activeIndex === images.length - 1} onClick={() => setActiveIndex((current) => current == null ? current : Math.min(images.length - 1, current + 1))}>›</button>
        <span className="image-lightbox-position" aria-live="polite">Image {activeIndex + 1} of {images.length}</span>
      </>}
      <img src={active.url} alt={`${label} ${active.attachmentIndex + 1} full size`} />
    </div>, document.body)}
  </>
}
