import exifr from 'exifr'

/**
 * 提取图片的EXIF数据
 * @param {File} file - 图片文件
 * @returns {Promise<Object>} EXIF数据对象
 */
export async function extractExifData(file) {
  try {
    const exifData = await exifr.parse(file, {
      // 指定要提取的EXIF字段
      pick: [
        'Make', 'Model', 'LensModel', 'Software',
        'DateTime', 'DateTimeOriginal', 'CreateDate',
        'ExposureTime', 'FNumber', 'ISO', 'FocalLength',
        'Flash', 'WhiteBalance', 'ColorSpace',
        'ImageWidth', 'ImageHeight', 'Orientation',
        'GPS', 'latitude', 'longitude'
      ]
    })

    // 如果没有EXIF数据，返回空对象
    if (!exifData) {
      return {}
    }

    // 处理和格式化某些字段
    const processedData = {
      ...exifData
    }

    // 处理日期格式
    if (exifData.DateTimeOriginal) {
      processedData.DateTime = exifData.DateTimeOriginal
    } else if (exifData.CreateDate) {
      processedData.DateTime = exifData.CreateDate
    }

    // 处理曝光时间格式
    if (exifData.ExposureTime) {
      if (exifData.ExposureTime < 1) {
        processedData.ExposureTime = exifData.ExposureTime
      } else {
        processedData.ExposureTime = `${exifData.ExposureTime}s`
      }
    }

    // 处理光圈值
    if (exifData.FNumber) {
      processedData.FNumber = parseFloat(exifData.FNumber.toFixed(1))
    }

    // 处理焦距
    if (exifData.FocalLength) {
      processedData.FocalLength = Math.round(exifData.FocalLength)
    }

    // 处理ISO值
    if (exifData.ISO) {
      processedData.ISO = exifData.ISO
    }

    return processedData
  } catch (error) {
    console.warn('提取EXIF数据失败:', error)
    return {}
  }
}

/**
 * 格式化EXIF值用于显示
 * @param {string} key - EXIF字段名
 * @param {any} value - EXIF值
 * @returns {string} 格式化后的显示值
 */
export function formatExifValue(key, value) {
  if (!value) return ''

  switch (key) {
    case 'FNumber':
      return `f/${value}`
    case 'ExposureTime':
      if (typeof value === 'number') {
        return value < 1 ? `1/${Math.round(1/value)}s` : `${value}s`
      }
      return value
    case 'FocalLength':
      return `${value}mm`
    case 'ISO':
      return `ISO ${value}`
    case 'DateTime':
    case 'DateTimeOriginal':
    case 'CreateDate':
      if (value instanceof Date) {
        return value.toLocaleString('zh-CN')
      } else if (typeof value === 'string') {
        const date = new Date(value)
        return isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
      }
      return value
    case 'Flash':
      const flashMap = {
        0: '未闪光',
        1: '闪光',
        5: '闪光，无返回',
        7: '闪光，有返回',
        9: '强制闪光',
        13: '强制闪光，无返回',
        15: '强制闪光，有返回',
        16: '未闪光，强制关闭',
        24: '未闪光，自动模式',
        25: '闪光，自动模式',
        29: '闪光，自动模式，无返回',
        31: '闪光，自动模式，有返回'
      }
      return flashMap[value] || `闪光模式 ${value}`
    case 'WhiteBalance':
      return value === 0 ? '自动白平衡' : '手动白平衡'
    case 'ColorSpace':
      return value === 1 ? 'sRGB' : value === 2 ? 'Adobe RGB' : `色彩空间 ${value}`
    default:
      return String(value)
  }
}

/**
 * 检查文件是否包含EXIF数据
 * @param {File} file - 图片文件
 * @returns {Promise<boolean>} 是否包含EXIF数据
 */
export async function hasExifData(file) {
  try {
    const exifData = await exifr.parse(file, { pick: ['Make'] })
    return !!exifData && Object.keys(exifData).length > 0
  } catch (error) {
    return false
  }
} 