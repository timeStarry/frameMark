import { ref } from 'vue'
import { exifLabels, defaultExifFields } from '../constants/positions'

export function useExifHandler() {
  const exifData = ref(null)
  const availableExifData = ref({})
  const selectedExifFields = ref([])

  // 格式化EXIF值
  const formatExifValue = (key, value) => {
    switch (key) {
      case 'FNumber':
        return `f/${value}`
      case 'ExposureTime':
        return value < 1 ? `1/${Math.round(1/value)}s` : `${value}s`
      case 'FocalLength':
        return `${value}mm`
      case 'ISO':
        return `ISO ${value}`
      case 'DateTime':
        return new Date(value).toLocaleDateString('zh-CN', { 
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit'
        })
      case 'Time':
        return new Date(value).toLocaleTimeString('zh-CN', { 
          hour: '2-digit', 
          minute: '2-digit'
        })
      default:
        return value
    }
  }

  // 格式化EXIF显示
  const formatExifDisplay = (key, value) => {
    return value
  }

  // 处理EXIF数据
  const processExifData = (exif) => {
    exifData.value = exif
    
    // 过滤可用的EXIF数据
    availableExifData.value = {}
    Object.keys(exifLabels).forEach(key => {
      if (key === 'Time') {
        // Time字段来源于DateTime数据
        if (exif['DateTime']) {
          availableExifData.value[key] = formatExifValue(key, exif['DateTime'])
        }
      } else if (exif[key]) {
        availableExifData.value[key] = formatExifValue(key, exif[key])
      }
    })

    // 默认选中常用EXIF字段
    selectedExifFields.value = defaultExifFields.filter(field => 
      availableExifData.value[field]
    )
  }

  // 获取实际的EXIF字体
  const getActualExifFont = (exifSettings, watermarkSettings) => {
    return exifSettings.fontFamily === 'follow-text' 
      ? watermarkSettings.fontFamily 
      : exifSettings.fontFamily
  }

  // 重置EXIF数据
  const resetExifData = () => {
    exifData.value = null
    availableExifData.value = {}
    selectedExifFields.value = []
  }

  return {
    exifData,
    availableExifData,
    selectedExifFields,
    formatExifValue,
    formatExifDisplay,
    processExifData,
    getActualExifFont,
    resetExifData
  }
} 