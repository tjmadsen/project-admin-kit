import { uploadAttachments } from '../data'
import type { UploadedAttachments as DataUploadedAttachments } from '../data/types'
import type { WorkKind } from './types'

export const MAX_IMAGE_MB = 25
export const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024
export const MAX_IMAGE_COUNT = 10

export const MAX_ATTACHMENT_MB = MAX_IMAGE_MB
export const MAX_ATTACHMENT_BYTES = MAX_IMAGE_BYTES
export const MAX_ATTACHMENT_COUNT = MAX_IMAGE_COUNT
export const ATTACHMENT_ACCEPT = 'image/*,.pdf,.csv,.txt'

export type AttachmentKind = 'image' | 'pdf' | 'csv' | 'txt'

export function documentKind(name: string): Exclude<AttachmentKind, 'image'> | undefined {
  const extension = name.match(/[.]([^.]+)$/)?.[1].toLowerCase()
  return extension === 'pdf' || extension === 'csv' || extension === 'txt' ? extension : undefined
}

export function isSupportedAttachment(file: Pick<File, 'name' | 'type'>) {
  return file.type.startsWith('image/') || documentKind(file.name) != null
}

export function attachmentContentType(file: File) {
  const kind = documentKind(file.name)
  if (kind === 'pdf') return 'application/pdf'
  if (kind === 'csv') return 'text/csv'
  if (kind === 'txt') return 'text/plain'
  return file.type
}

export function attachmentFilesFromDataTransfer(items: DataTransferItemList | null | undefined): File[] {
  if (!items) return []
  return Array.from(items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null && isSupportedAttachment(file))
}

export function mergeAttachmentFiles(existing: File[], incoming: File[]) {
  const accepted: File[] = []
  const errors: string[] = []
  for (const file of incoming) {
    if (!isSupportedAttachment(file)) { errors.push(`${file.name || 'File'} must be an image, PDF, CSV, or TXT file.`); continue }
    if (file.size > MAX_ATTACHMENT_BYTES) { errors.push(`${file.name || 'File'} exceeds ${MAX_ATTACHMENT_MB} MB.`); continue }
    if (existing.length + accepted.length >= MAX_ATTACHMENT_COUNT) { errors.push(`You can attach up to ${MAX_ATTACHMENT_COUNT} files.`); break }
    accepted.push(file)
  }
  return { files: [...existing, ...accepted], error: errors[0] || '' }
}

export function imageFilesFromDataTransfer(items: DataTransferItemList | null | undefined): File[] {
  return attachmentFilesFromDataTransfer(items).filter((file) => file.type.startsWith('image/'))
}

export function mergeImageFiles(existing: File[], incoming: File[]) {
  const nonImage = incoming.find((file) => !file.type.startsWith('image/'))
  if (nonImage) return { files: existing, error: `${nonImage.name || 'File'} is not an image.` }
  return mergeAttachmentFiles(existing, incoming)
}

export function safeAttachmentName(name: string) {
  return (name || 'pasted-image.png').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
}

export type UploadedImages = DataUploadedAttachments
export type UploadedAttachments = UploadedImages

// Storage depends on the backend: Firebase Storage for firestore builds, files
// beside the local store for local builds (see data/).
export async function uploadWorkAttachments(files: File[], kind: WorkKind, itemId: string, uploaderEmail: string): Promise<UploadedAttachments> {
  return uploadAttachments(files, kind, itemId, uploaderEmail)
}

export async function uploadWorkImages(files: File[], kind: WorkKind, itemId: string, uploaderEmail: string): Promise<UploadedImages> {
  return uploadWorkAttachments(files, kind, itemId, uploaderEmail)
}
