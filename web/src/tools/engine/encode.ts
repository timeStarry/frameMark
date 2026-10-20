export interface EncodeSettings {
  format: 'image/jpeg' | 'image/png' | 'image/webp'
  quality: number
}

export function encode(canvas: HTMLCanvasElement, d: EncodeSettings): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('编码失败，请尝试较小尺寸。'))
        } else if (blob.type !== d.format) {
          reject(new Error('浏览器不支持此格式，请选择 PNG。'))
        } else {
          resolve(blob)
        }
      },
      d.format,
      d.quality / 100,
    )
  })
}
