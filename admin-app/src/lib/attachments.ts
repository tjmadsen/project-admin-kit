import { deleteObject, getDownloadURL, ref as storageRef, uploadBytes, type StorageReference } from 'firebase/storage'
import { auth, storage } from './firebase'
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

function attachmentContentType(file: File) {
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

function safeFileName(name: string) {
  return (name || 'pasted-image.png').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
}

export interface UploadedImages {
  urls: string[]
  cleanup: () => Promise<void>
}

export type UploadedAttachments = UploadedImages

export async function uploadWorkAttachments(files: File[], kind: WorkKind, itemId: string, uploaderEmail: string): Promise<UploadedAttachments> {
  if (files.length === 0) return { urls: [], cleanup: async () => undefined }
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('Your Google session expired. Sign in again before uploading attachments.')
  const uploaded: StorageReference[] = []
  try {
    for (const [index, file] of files.entries()) {
      const unique = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`
      const path = `work-item-attachments/${uid}/${kind}/${itemId}/${unique}-${safeFileName(file.name)}`
      const target = storageRef(storage, path)
      await uploadBytes(target, file, {
        contentType: attachmentContentType(file),
        customMetadata: { uploaderEmail: uploaderEmail.toLowerCase(), kind, itemId },
      })
      uploaded.push(target)
    }
    const urls = await Promise.all(uploaded.map((target) => getDownloadURL(target)))
    return { urls, cleanup: async () => { await Promise.allSettled(uploaded.map((target) => deleteObject(target))) } }
  } catch (error) {
    await Promise.allSettled(uploaded.map((target) => deleteObject(target)))
    throw error
  }
}

export async function uploadWorkImages(files: File[], kind: WorkKind, itemId: string, uploaderEmail: string): Promise<UploadedImages> {
  return uploadWorkAttachments(files, kind, itemId, uploaderEmail)
}
