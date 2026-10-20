import exifr from 'exifr'

export const fields: Record<string, string> = {
  Model: '相机',
  LensModel: '镜头',
  FocalLength: '焦距',
  FNumber: '光圈',
  ExposureTime: '快门',
  ISO: 'ISO',
}

export function mapExif(raw: Record<string, unknown> | undefined | null): Record<string, string> {
  const metadata: Record<string, string> = {}
  if (!raw) return metadata
  for (const key of Object.keys(fields)) {
    if (raw[key] != null) metadata[key] = String(raw[key])
  }
  return metadata
}

export async function parseExif(file: File): Promise<Record<string, string>> {
  try {
    const raw = await exifr.parse(file, { pick: Object.keys(fields), gps: false })
    return mapExif(raw as Record<string, unknown> | undefined)
  } catch {
    // Metadata failure does not invalidate the photograph.
    return {}
  }
}
