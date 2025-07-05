// 九宫格位置选项
export const positionOptions = [
  { value: 'top-left', label: '左上角' },
  { value: 'top-center', label: '上部居中' },
  { value: 'top-right', label: '右上角' },
  { value: 'middle-left', label: '左侧中间' },
  { value: 'middle-center', label: '正中央' },
  { value: 'middle-right', label: '右侧中间' },
  { value: 'bottom-left', label: '左下角' },
  { value: 'bottom-center', label: '下部居中' },
  { value: 'bottom-right', label: '右下角' }
]

// EXIF字段标签映射
export const exifLabels = {
  Make: '品牌',
  Model: '型号',
  LensModel: '镜头',
  FNumber: '光圈',
  ExposureTime: '快门',
  ISO: 'ISO',
  FocalLength: '焦距',
  DateTime: '📅日期',
  Time: '🕐时间',
  Flash: '闪光灯',
  WhiteBalance: '白平衡'
}

// 默认选中的EXIF字段
export const defaultExifFields = ['FNumber', 'ExposureTime', 'FocalLength', 'ISO'] 