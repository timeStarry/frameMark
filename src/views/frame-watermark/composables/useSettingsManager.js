import { reactive, ref, nextTick } from 'vue'
import { morandiColors, gradientCombos } from '../constants/colors'

export function useSettingsManager() {
  // 折叠状态
  const sectionsOpen = reactive({
    upload: true,
    presets: true,
    frame: false,
    watermark: false,
    exif: false
  })

  // 边框设置
  const frameSettings = reactive({
    type: 'blur',
    widthPercent: 8,
    borderRadiusPercent: 1.5,
    color: '#ffffff',
    gradientColor1: '#FFB347',
    gradientColor2: '#FF8C94',
    blurIntensity: 35,
    showMoreColors: false
  })

  // 水印设置
  const watermarkSettings = reactive({
    text: 'Photographer',
    fontFamily: 'Dancing Script',
    fontSizePercent: 2.5,
    color: '#ffffff',
    opacity: 0.9,
    position: 'bottom-center',
    bottomBarPosition: 'left'
  })

  // EXIF设置
  const exifSettings = reactive({
    fontFamily: 'follow-text',
    fontSizePercent: 2.0,
    position: 'bottom-center',
    bottomBarPosition: 'right'
  })

  // 自定义文件名
  const customFileName = ref('')

  // 切换折叠状态
  const toggleSection = (section) => {
    sectionsOpen[section] = !sectionsOpen[section]
  }

  // 选择莫兰蒂色系
  const selectMorandiColor = (color) => {
    frameSettings.color = color
  }

  // 选择渐变色组合
  const selectGradientCombo = (colors) => {
    frameSettings.gradientColor1 = colors[0]
    frameSettings.gradientColor2 = colors[1]
  }

  // 切换更多颜色选项显示
  const toggleMoreColors = () => {
    frameSettings.showMoreColors = !frameSettings.showMoreColors
  }

  // 选择字体
  const selectFont = (type, fontName, watermarkSettings, exifSettings, generatePreviewCallback) => {
    if (type === 'watermark') {
      watermarkSettings.fontFamily = fontName
    } else if (type === 'exif') {
      exifSettings.fontFamily = fontName
    }
    
    // 重新生成预览
    if (generatePreviewCallback) {
      generatePreviewCallback()
    }
  }

  // 应用预设配置
  const applyPreset = async (preset, availableExifData, selectedExifFields, generatePreviewCallback) => {
    const config = preset.config
    
    // 应用边框设置
    if (config.frame) {
      Object.assign(frameSettings, {
        type: config.frame.type,
        widthPercent: config.frame.widthPercent || frameSettings.widthPercent,
        borderRadiusPercent: config.frame.borderRadiusPercent ?? frameSettings.borderRadiusPercent,
        color: config.frame.color || frameSettings.color,
        gradientColor1: config.frame.gradientColor1 || frameSettings.gradientColor1,
        gradientColor2: config.frame.gradientColor2 || frameSettings.gradientColor2,
        blurIntensity: config.frame.blurIntensity || frameSettings.blurIntensity,
        showMoreColors: false
      })
    }
    
    // 应用水印设置
    if (config.watermark) {
      Object.assign(watermarkSettings, {
        text: config.watermark.text || watermarkSettings.text,
        fontFamily: config.watermark.fontFamily || watermarkSettings.fontFamily,
        fontSizePercent: config.watermark.fontSizePercent || watermarkSettings.fontSizePercent,
        color: config.watermark.color || watermarkSettings.color,
        opacity: config.watermark.opacity ?? watermarkSettings.opacity,
        position: config.watermark.position || watermarkSettings.position,
        bottomBarPosition: config.watermark.bottomBarPosition || watermarkSettings.bottomBarPosition
      })
    }
    
    // 应用EXIF设置
    if (config.exif) {
      Object.assign(exifSettings, {
        fontFamily: config.exif.fontFamily || exifSettings.fontFamily,
        fontSizePercent: config.exif.fontSizePercent || exifSettings.fontSizePercent,
        position: config.exif.position || exifSettings.position,
        bottomBarPosition: config.exif.bottomBarPosition || exifSettings.bottomBarPosition
      })
      
      // 设置选中的EXIF字段
      if (config.exif.fields) {
        selectedExifFields.value = config.exif.fields.filter(field => 
          availableExifData.value[field]
        )
      }
    }
    
    // 展开相关设置区域
    sectionsOpen.presets = true
    sectionsOpen.frame = true
    sectionsOpen.watermark = true
    if (Object.keys(availableExifData.value).length > 0) {
      sectionsOpen.exif = true
    }
    
    // 等待DOM更新后生成预览
    await nextTick()
    if (generatePreviewCallback) {
      await generatePreviewCallback()
    }
  }

  // 重置所有设置
  const resetAllSettings = () => {
    frameSettings.type = 'blur'
    frameSettings.widthPercent = 8
    frameSettings.borderRadiusPercent = 1.5
    frameSettings.color = '#ffffff'
    frameSettings.gradientColor1 = '#FFB347'
    frameSettings.gradientColor2 = '#FF8C94'
    frameSettings.blurIntensity = 35
    frameSettings.showMoreColors = false
    
    watermarkSettings.text = 'Photographer'
    watermarkSettings.fontFamily = 'Dancing Script'
    watermarkSettings.fontSizePercent = 2.5
    watermarkSettings.color = '#ffffff'
    watermarkSettings.opacity = 0.9
    watermarkSettings.position = 'bottom-center'
    watermarkSettings.bottomBarPosition = 'left'
    
    exifSettings.fontFamily = 'follow-text'
    exifSettings.fontSizePercent = 2.0
    exifSettings.position = 'bottom-center'
    exifSettings.bottomBarPosition = 'right'
    
    customFileName.value = ''
    
    sectionsOpen.upload = true
    sectionsOpen.presets = true
    sectionsOpen.frame = false
    sectionsOpen.watermark = false
    sectionsOpen.exif = false
  }

  return {
    sectionsOpen,
    frameSettings,
    watermarkSettings,
    exifSettings,
    customFileName,
    morandiColors,
    gradientCombos,
    toggleSection,
    selectMorandiColor,
    selectGradientCombo,
    toggleMoreColors,
    selectFont,
    applyPreset,
    resetAllSettings
  }
} 