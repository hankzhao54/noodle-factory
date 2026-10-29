import { supabase } from './supabase'
import { compressImage } from './image'

export const IMAGE_BUCKET = 'noodle-images'

export const imageUrl = path =>
  path && supabase ? supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl : null

// upload a picked photo for materials/<id> or products/<id>; returns the stored path
export async function uploadImage(folder, id, file) {
  const { blob, ext, type } = await compressImage(file, 1200, 0.82)
  const path = `${folder}/${id}/${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, blob, { contentType: type, upsert: false })
  if (error) throw error
  return path
}

export async function removeImage(path) {
  if (!path) return
  await supabase.storage.from(IMAGE_BUCKET).remove([path]) // best effort; the row update is what matters
}
