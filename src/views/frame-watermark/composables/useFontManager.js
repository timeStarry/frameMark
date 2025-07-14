import { ref, reactive } from 'vue'
import { fontLibrary, fontDisplayNames } from '../constants/fonts'

export function useFontManager() {
  // 字体加载状态
  const fontsLoaded = ref(false)
  const availableFonts = ref({})

  // 字体选择器下拉状态
  const showFontDropdown = reactive({
    watermark: false,
    exif: false
  })

  // 获取字体显示名称
  const getFontDisplayName = (fontName) => {
    return fontDisplayNames[fontName] || fontName
  }

  // 检测单个字体是否可用
  const isFontAvailable = (fontFamily) => {
    // 方法1：使用document.fonts.check API（现代浏览器）
    if (document.fonts && document.fonts.check) {
      try {
        // 先检查字体是否已加载
        const isLoaded = document.fonts.check(`16px "${fontFamily}"`)
        if (isLoaded) {
          return true
        }
      } catch (e) {
        // 如果API调用失败，使用备用方法
      }
    }
    
    // 方法2：Canvas测量法（备用方法）
    const testText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const testSize = '16px'
    const fallbackFont = 'monospace'
    
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    
    // 测量使用备用字体的文本宽度
    ctx.font = `${testSize} ${fallbackFont}`
    const fallbackWidth = ctx.measureText(testText).width
    
    // 测量使用目标字体的文本宽度
    ctx.font = `${testSize} "${fontFamily}", ${fallbackFont}`
    const targetWidth = ctx.measureText(testText).width
    
    // 如果宽度不同，说明目标字体可用
    const isAvailable = Math.abs(targetWidth - fallbackWidth) > 1
    
    // 额外检查：使用系统字体作为对照
    ctx.font = `${testSize} "${fontFamily}", Arial`
    const arialWidth = ctx.measureText(testText).width
    
    // 如果与Arial宽度也不同，更确认字体可用
    return isAvailable || Math.abs(arialWidth - fallbackWidth) > 1
  }

  // 加载Google Fonts
  const loadGoogleFonts = async () => {
    // 由于index.html已经预加载了Google Fonts，这里主要确保字体完全加载
    console.log('确保Google Fonts已加载...')
    
    // 等待字体加载完成
    await document.fonts.ready
    
    // 额外等待确保字体完全可用
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    console.log('Google Fonts加载完成')
    return true
  }

  // 检测所有字体可用性
  const detectAvailableFonts = async () => {
    console.log('正在检测可用字体...')
    
    try {
      // 先加载Google Fonts
      await loadGoogleFonts()
      
      // 等待字体加载完成
      await document.fonts.ready
      
      // 额外等待确保字体完全可用
      await new Promise(resolve => setTimeout(resolve, 1500))
      
      const detected = {}
      
      // 遍历所有字体分类
      for (const [categoryKey, category] of Object.entries(fontLibrary)) {
        detected[categoryKey] = {
          name: category.name,
          fonts: []
        }
        
        // 检测分类中的每个字体
        for (const fontName of category.fonts) {
          if (isFontAvailable(fontName)) {
            detected[categoryKey].fonts.push(fontName)
          }
        }
        
        // 如果分类中没有可用字体，移除该分类
        if (detected[categoryKey].fonts.length === 0) {
          delete detected[categoryKey]
        }
      }
      
      availableFonts.value = detected
      
      fontsLoaded.value = true
      
      console.log('字体检测完成:', {
        总分类数: Object.keys(detected).length,
        可用字体数: Object.values(detected).flatMap(category => category.fonts).length,
        详细信息: detected
      })
      
      return true
    } catch (error) {
      console.warn('字体检测失败:', error)
      // 降级处理：使用系统字体
      availableFonts.value = {
        system: {
          name: '系统字体',
          fonts: ['Arial', 'sans-serif', 'serif', 'monospace']
        }
      }
      fontsLoaded.value = true
      return true
    }
  }

  // 检查字体是否加载完成（简化版，主要用于渲染时确保字体可用）
  const checkFontsLoaded = async () => {
    if (!fontsLoaded.value) {
      await detectAvailableFonts()
    }
    
    // 额外等待确保字体完全可用
    await new Promise(resolve => setTimeout(resolve, 100))
    return true
  }

  // 切换字体选择器下拉菜单
  const toggleFontDropdown = (type) => {
    if (!fontsLoaded.value) return
    
    // 关闭其他下拉菜单
    Object.keys(showFontDropdown).forEach(key => {
      if (key !== type) {
        showFontDropdown[key] = false
      }
    })
    
    // 切换当前下拉菜单
    showFontDropdown[type] = !showFontDropdown[type]
  }

  // 点击外部区域关闭字体选择器
  const handleClickOutside = (event) => {
    const fontSelectors = document.querySelectorAll('.font-selector')
    let isClickInside = false
    
    fontSelectors.forEach(selector => {
      if (selector.contains(event.target)) {
        isClickInside = true
      }
    })
    
    if (!isClickInside) {
      Object.keys(showFontDropdown).forEach(key => {
        showFontDropdown[key] = false
      })
    }
  }

  return {
    fontsLoaded,
    availableFonts,
    showFontDropdown,
    getFontDisplayName,
    detectAvailableFonts,
    checkFontsLoaded,
    toggleFontDropdown,
    handleClickOutside
  }
} 