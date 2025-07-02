/**
 * 下载Blob对象为文件
 * @param {Blob} blob - 要下载的Blob对象
 * @param {string} filename - 文件名
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 读取文件为ArrayBuffer
 * @param {File} file - 文件对象
 * @returns {Promise<ArrayBuffer>} ArrayBuffer
 */
export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

/**
 * 读取文件为DataURL
 * @param {File} file - 文件对象
 * @returns {Promise<string>} DataURL字符串
 */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * 创建图片对象
 * @param {string} src - 图片源
 * @returns {Promise<HTMLImageElement>} 图片对象
 */
export function createImageFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

/**
 * 压缩图片
 * @param {File} file - 图片文件
 * @param {number} quality - 压缩质量 (0-1)
 * @param {number} maxWidth - 最大宽度
 * @param {number} maxHeight - 最大高度
 * @returns {Promise<Blob>} 压缩后的图片Blob
 */
export async function compressImage(file, quality = 0.8, maxWidth = 1920, maxHeight = 1080) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const img = await createImageFromSrc(URL.createObjectURL(file))
  
  // 计算新的尺寸
  let { width, height } = img
  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height)
    width *= ratio
    height *= ratio
  }
  
  canvas.width = width
  canvas.height = height
  
  // 绘制图片
  ctx.drawImage(img, 0, 0, width, height)
  
  // 转换为Blob
  return new Promise(resolve => {
    canvas.toBlob(resolve, 'image/jpeg', quality)
  })
}

/**
 * 获取图片尺寸
 * @param {File} file - 图片文件
 * @returns {Promise<{width: number, height: number}>} 图片尺寸
 */
export async function getImageDimensions(file) {
  const img = await createImageFromSrc(URL.createObjectURL(file))
  return {
    width: img.naturalWidth,
    height: img.naturalHeight
  }
}

/**
 * 验证文件类型
 * @param {File} file - 文件对象
 * @param {string[]} allowedTypes - 允许的MIME类型数组
 * @returns {boolean} 是否为允许的类型
 */
export function validateFileType(file, allowedTypes = ['image/jpeg', 'image/png', 'image/webp']) {
  return allowedTypes.includes(file.type)
}

/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的文件大小
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes'
  
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * 生成唯一文件名
 * @param {string} originalName - 原始文件名
 * @param {string} suffix - 后缀
 * @returns {string} 新的文件名
 */
export function generateUniqueFilename(originalName, suffix = '') {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substr(2, 5)
  const nameWithoutExt = originalName.split('.').slice(0, -1).join('.')
  const ext = originalName.split('.').pop()
  
  return `${nameWithoutExt}${suffix}_${timestamp}_${random}.${ext}`
} 