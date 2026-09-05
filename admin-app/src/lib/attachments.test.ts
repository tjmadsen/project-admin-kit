import { describe, expect, it } from 'vitest'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, attachmentFilesFromDataTransfer, documentKind, mergeAttachmentFiles } from './attachments'

describe('work-item attachments', () => {
  it('extracts supported images and documents from clipboard items', () => {
    const image = new File(['pixels'], 'shot.png', { type: 'image/png' })
    const text = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const word = new File(['document'], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const items = [
      { kind: 'file', type: 'image/png', getAsFile: () => image },
      { kind: 'file', type: 'text/plain', getAsFile: () => text },
      { kind: 'file', type: word.type, getAsFile: () => word },
    ] as unknown as DataTransferItemList
    expect(attachmentFilesFromDataTransfer(items)).toEqual([image, text])
  })

  it('accepts PDF, CSV, and TXT extensions regardless of browser MIME inference', () => {
    const files = [
      new File(['pdf'], 'report.PDF', { type: '' }),
      new File(['csv'], 'players.csv', { type: 'application/vnd.ms-excel' }),
      new File(['txt'], 'notes.txt', { type: '' }),
    ]
    expect(mergeAttachmentFiles([], files)).toEqual({ files, error: '' })
    expect(files.map((file) => documentKind(file.name))).toEqual(['pdf', 'csv', 'txt'])
    expect(documentKind('pdf')).toBeUndefined()
  })

  it('rejects unsupported and oversized files', () => {
    const word = new File(['document'], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const oversized = new File(['x'], 'huge.pdf', { type: 'application/pdf' })
    Object.defineProperty(oversized, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })
    expect(mergeAttachmentFiles([], [word]).error).toMatch(/image, PDF, CSV, or TXT/i)
    expect(mergeAttachmentFiles([], [oversized]).error).toMatch(/exceeds/i)
  })

  it('caps a work item at ten attachments', () => {
    const existing = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index) => new File(['x'], `${index}.txt`, { type: 'text/plain' }))
    const result = mergeAttachmentFiles(existing, [new File(['x'], 'extra.pdf', { type: 'application/pdf' })])
    expect(result.files).toHaveLength(MAX_ATTACHMENT_COUNT)
    expect(result.error).toMatch(/up to 10/i)
  })
})
