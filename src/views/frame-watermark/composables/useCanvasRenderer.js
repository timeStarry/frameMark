import { ref } from 'vue'

export function useCanvasRenderer() {
  // 预览控制
  const zoomLevel = ref(1)
  const panX = ref(0)
  const panY = ref(0)
  const isDragging = ref(false)
  const lastMousePos = ref({ x: 0, y: 0 })

  // 预览控制方法
  const handleWheel = (event, selectedImage) => {
    if (!selectedImage) return
    
    event.preventDefault()
    const delta = event.deltaY > 0 ? -0.1 : 0.1
    zoomLevel.value = Math.max(0.1, Math.min(3, zoomLevel.value + delta))
  }

  const startDrag = (event, selectedImage) => {
    if (!selectedImage) return
    
    isDragging.value = true
    lastMousePos.value = { x: event.clientX, y: event.clientY }
  }

  const handleDrag = (event) => {
    if (!isDragging.value) return
    
    const deltaX = event.clientX - lastMousePos.value.x
    const deltaY = event.clientY - lastMousePos.value.y
    
    panX.value += deltaX / zoomLevel.value
    panY.value += deltaY / zoomLevel.value
    
    lastMousePos.value = { x: event.clientX, y: event.clientY }
  }

  const endDrag = () => {
    isDragging.value = false
  }

  const resetZoom = () => {
    zoomLevel.value = 1
    panX.value = 0
    panY.value = 0
  }

  // 绘制边框
  const drawFrame = (ctx, canvasWidth, canvasHeight, img, originalWidth, originalHeight, frameSettings, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont) => {
    // 清空画布
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)

    // 底边条幅特殊处理
    if (frameSettings.type === 'bottom-bar') {
      drawBottomBarFrame(ctx, canvasWidth, canvasHeight, img, originalWidth, originalHeight, frameSettings, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont)
      return
    }

    // 其他边框类型的处理
    drawRegularFrame(ctx, canvasWidth, canvasHeight, img, originalWidth, originalHeight, frameSettings, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont)
  }

  // 绘制底边条幅
  const drawBottomBarFrame = (ctx, canvasWidth, canvasHeight, img, originalWidth, originalHeight, frameSettings, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont) => {
    // 计算条幅高度（原图高度的12%）
    const barHeight = originalHeight * 0.12
    // 计算三边边框宽度
    const threeSideBorderWidth = Math.min(originalWidth, originalHeight) * (frameSettings.widthPercent / 100)
    
    // 计算缩放比例 - 基于图片+条幅+三边边框的总尺寸
    const totalWidth = originalWidth + threeSideBorderWidth * 2
    const totalHeight = originalHeight + barHeight + threeSideBorderWidth
    const scale = Math.min(canvasWidth / totalWidth, canvasHeight / totalHeight)
    
    const scaledImageWidth = originalWidth * scale
    const scaledImageHeight = originalHeight * scale
    const scaledBarHeight = barHeight * scale
    const scaledBorderWidth = threeSideBorderWidth * scale
    
    // 计算居中位置
    const scaledTotalWidth = scaledImageWidth + scaledBorderWidth * 2
    const scaledTotalHeight = scaledImageHeight + scaledBarHeight + scaledBorderWidth
    const offsetX = (canvasWidth - scaledTotalWidth) / 2
    const offsetY = (canvasHeight - scaledTotalHeight) / 2

    ctx.save()
    ctx.translate(offsetX, offsetY)
    
    // 如果有三边边框，先绘制三边边框背景
    if (frameSettings.widthPercent > 0) {
      ctx.fillStyle = '#ffffff' // 三边边框使用白色
      // 左边框
      ctx.fillRect(0, 0, scaledBorderWidth, scaledImageHeight + scaledBorderWidth)
      // 右边框
      ctx.fillRect(scaledBorderWidth + scaledImageWidth, 0, scaledBorderWidth, scaledImageHeight + scaledBorderWidth)
      // 顶边框
      ctx.fillRect(scaledBorderWidth, 0, scaledImageWidth, scaledBorderWidth)
    }
    
    // 绘制原图（考虑三边边框的偏移）
    ctx.drawImage(img, scaledBorderWidth, scaledBorderWidth, scaledImageWidth, scaledImageHeight)
    
    // 绘制底部白色条幅（全宽度）
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, scaledImageHeight + scaledBorderWidth, scaledTotalWidth, scaledBarHeight)
    
    // 绘制条幅中的水印和EXIF信息
    drawBottomBarContent(ctx, scaledTotalWidth, scaledImageHeight + scaledBorderWidth, scaledBarHeight, originalWidth, originalHeight, scale, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont)
    
    ctx.restore()
  }

  // 绘制常规边框
  const drawRegularFrame = (ctx, canvasWidth, canvasHeight, img, originalWidth, originalHeight, frameSettings, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont) => {
    // 计算边框宽度和圆角 - 基于原图尺寸的百分比
    const frameWidth = Math.min(originalWidth, originalHeight) * (frameSettings.widthPercent / 100)
    const borderRadius = Math.min(originalWidth, originalHeight) * (frameSettings.borderRadiusPercent / 100)
    
    // 计算缩放比例
    const scale = Math.min(canvasWidth / (originalWidth + frameWidth * 2), 
                          canvasHeight / (originalHeight + frameWidth * 2))
    
    // 应用缩放
    const scaledFrameWidth = frameWidth * scale
    const scaledBorderRadius = borderRadius * scale
    const scaledImageWidth = originalWidth * scale
    const scaledImageHeight = originalHeight * scale
    
    // 计算居中位置
    const totalWidth = scaledImageWidth + scaledFrameWidth * 2
    const totalHeight = scaledImageHeight + scaledFrameWidth * 2
    const offsetX = (canvasWidth - totalWidth) / 2
    const offsetY = (canvasHeight - totalHeight) / 2

    // 绘制边框背景
    ctx.save()
    ctx.translate(offsetX, offsetY)
    
    if (frameSettings.type === 'blur') {
      // 模糊边框
      drawBlurFrame(ctx, totalWidth, totalHeight, scaledFrameWidth, img, scaledImageWidth, scaledImageHeight, frameSettings)
      
      // 绘制主图片（带圆角裁剪）
      const imageX = scaledFrameWidth
      const imageY = scaledFrameWidth

      ctx.save()
      ctx.beginPath()
      ctx.roundRect(imageX, imageY, scaledImageWidth, scaledImageHeight, scaledBorderRadius)
      ctx.clip()
      ctx.drawImage(img, imageX, imageY, scaledImageWidth, scaledImageHeight)
      ctx.restore()

      // 绘制水印 - 在边框区域
      drawWatermark(ctx, totalWidth, totalHeight, scaledFrameWidth, originalWidth, originalHeight, scale, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont)
    } else {
      // 其他边框类型
      if (frameSettings.type === 'solid') {
        ctx.fillStyle = frameSettings.color
        ctx.fillRect(0, 0, totalWidth, totalHeight)
      } else if (frameSettings.type === 'gradient') {
        const gradient = ctx.createLinearGradient(0, 0, totalWidth, totalHeight)
        gradient.addColorStop(0, frameSettings.gradientColor1)
        gradient.addColorStop(1, frameSettings.gradientColor2)
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, totalWidth, totalHeight)
      }

      // 绘制主图片（带圆角裁剪）
      const imageX = scaledFrameWidth
      const imageY = scaledFrameWidth

      ctx.save()
      ctx.beginPath()
      ctx.roundRect(imageX, imageY, scaledImageWidth, scaledImageHeight, scaledBorderRadius)
      ctx.clip()
      ctx.drawImage(img, imageX, imageY, scaledImageWidth, scaledImageHeight)
      ctx.restore()

      // 绘制水印 - 在边框区域
      drawWatermark(ctx, totalWidth, totalHeight, scaledFrameWidth, originalWidth, originalHeight, scale, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont)
    }
    
    ctx.restore()
  }

  // 绘制模糊边框
  const drawBlurFrame = (ctx, totalWidth, totalHeight, frameWidth, img, imageWidth, imageHeight, frameSettings) => {
    // 计算实际模糊值
    const actualBlur = Math.max(2, frameSettings.blurIntensity * 1.6)
    
    // 创建高质量毛玻璃效果
    const baseCanvas = document.createElement('canvas')
    const baseCtx = baseCanvas.getContext('2d')
    baseCanvas.width = totalWidth
    baseCanvas.height = totalHeight
    
    // 应用基础模糊
    baseCtx.filter = `blur(${actualBlur}px) contrast(0.98) saturate(1.05)`
    baseCtx.drawImage(img, 0, 0, totalWidth, totalHeight)
    
    // 增强模糊深度
    const enhancedCanvas = document.createElement('canvas')
    const enhancedCtx = enhancedCanvas.getContext('2d')
    enhancedCanvas.width = totalWidth
    enhancedCanvas.height = totalHeight
    
    enhancedCtx.filter = `blur(${actualBlur * 0.6}px)`
    enhancedCtx.drawImage(baseCanvas, 0, 0)
    
    // 高强度时的额外模糊
    if (frameSettings.blurIntensity > 30) {
      const deepBlurCanvas = document.createElement('canvas')
      const deepBlurCtx = deepBlurCanvas.getContext('2d')
      deepBlurCanvas.width = totalWidth
      deepBlurCanvas.height = totalHeight
      
      const extraBlur = (frameSettings.blurIntensity - 30) * 1.5
      deepBlurCtx.filter = `blur(${extraBlur}px)`
      deepBlurCtx.drawImage(enhancedCanvas, 0, 0)
      
      enhancedCtx.globalCompositeOperation = 'normal'
      enhancedCtx.globalAlpha = 0.7
      enhancedCtx.drawImage(deepBlurCanvas, 0, 0)
      enhancedCtx.globalAlpha = 1
    }
    
    // 最终质感调整
    const finalCanvas = document.createElement('canvas')
    const finalCtx = finalCanvas.getContext('2d')
    finalCanvas.width = totalWidth
    finalCanvas.height = totalHeight
    
    finalCtx.drawImage(enhancedCanvas, 0, 0)
    
    // 极高强度时的暗化效果
    if (frameSettings.blurIntensity > 45) {
      finalCtx.globalCompositeOperation = 'multiply'
      finalCtx.fillStyle = `rgba(250, 248, 246, 0.97)`
      finalCtx.fillRect(0, 0, totalWidth, totalHeight)
    }
    
    // 绘制到主画布
    ctx.drawImage(finalCanvas, 0, 0)
  }

  // 绘制底部条幅内容
  const drawBottomBarContent = (ctx, barWidth, imageHeight, barHeight, originalWidth, originalHeight, scale, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont) => {
    if (!watermarkSettings.text && selectedExifFields.length === 0) return

    // 设置透明度
    ctx.globalAlpha = watermarkSettings.opacity
    
    // 计算条幅内的边距
    const padding = barHeight * 0.15
    
    // 准备水印文本信息
    let watermarkInfo = null
    if (watermarkSettings.text) {
      const fontSize = Math.min(barHeight * 0.6, originalHeight * (watermarkSettings.fontSizePercent / 100) * scale)
      watermarkInfo = {
        text: watermarkSettings.text,
        font: `${fontSize}px ${watermarkSettings.fontFamily}`,
        color: '#333333',
        fontSize: fontSize
      }
    }
    
    // 准备EXIF文本信息
    let exifInfo = null
    const exifValues = selectedExifFields
      .map(field => availableExifData[field])
      .filter(Boolean)
    
    if (exifValues.length > 0) {
      const fontSize = Math.min(barHeight * 0.5, originalHeight * (exifSettings.fontSizePercent / 100) * scale)
      exifInfo = {
        text: exifValues.join('  '),
        font: `${fontSize}px ${getActualExifFont()}`,
        color: '#666666',
        fontSize: fontSize
      }
    }

    // 获取各自的位置设置
    const watermarkPos = watermarkSettings.bottomBarPosition || 'left'
    const exifPos = exifSettings.bottomBarPosition || 'right'
    
    // 计算文本位置
    const positions = {
      left: { align: 'left', x: padding },
      center: { align: 'center', x: barWidth / 2 },
      right: { align: 'right', x: barWidth - padding }
    }

    // 条幅的Y起始位置
    const barTop = imageHeight
    
    // 绘制水印和EXIF
    if (watermarkPos === exifPos) {
      // 同一位置：水印在上，EXIF在下
      const pos = positions[watermarkPos]
      ctx.textAlign = pos.align
      
      if (watermarkInfo) {
        ctx.font = watermarkInfo.font
        ctx.fillStyle = watermarkInfo.color
        const watermarkY = barTop + barHeight * 0.4
        ctx.fillText(watermarkInfo.text, pos.x, watermarkY)
      }
      
      if (exifInfo) {
        ctx.font = exifInfo.font
        ctx.fillStyle = exifInfo.color
        const exifY = barTop + barHeight * 0.75
        ctx.fillText(exifInfo.text, pos.x, exifY)
      }
    } else {
      // 不同位置：分别绘制
      if (watermarkInfo) {
        const pos = positions[watermarkPos]
        ctx.textAlign = pos.align
        ctx.font = watermarkInfo.font
        ctx.fillStyle = watermarkInfo.color
        const watermarkY = barTop + barHeight * 0.6
        ctx.fillText(watermarkInfo.text, pos.x, watermarkY)
      }
      
      if (exifInfo) {
        const pos = positions[exifPos]
        ctx.textAlign = pos.align
        ctx.font = exifInfo.font
        ctx.fillStyle = exifInfo.color
        const exifY = barTop + barHeight * 0.6
        ctx.fillText(exifInfo.text, pos.x, exifY)
      }
    }

    // 恢复透明度
    ctx.globalAlpha = 1
  }

  // 绘制水印
  const drawWatermark = (ctx, totalWidth, totalHeight, frameWidth, originalWidth, originalHeight, scale, watermarkSettings, exifSettings, selectedExifFields, availableExifData, getActualExifFont) => {
    if (!watermarkSettings.text && selectedExifFields.length === 0) return

    // 设置透明度
    ctx.globalAlpha = watermarkSettings.opacity
    
    // 计算边距和区域
    const padding = frameWidth * 0.3
    
    // 九宫格位置计算函数
    const getPositionCoords = (position) => {
      switch (position) {
        case 'top-left':
          return { x: padding, y: frameWidth - padding, align: 'left', baseline: 'bottom' }
        case 'top-center':
          return { x: totalWidth / 2, y: frameWidth - padding, align: 'center', baseline: 'bottom' }
        case 'top-right':
          return { x: totalWidth - padding, y: frameWidth - padding, align: 'right', baseline: 'bottom' }
        case 'middle-left':
          return { x: padding, y: totalHeight / 2, align: 'left', baseline: 'middle' }
        case 'middle-center':
          return { x: totalWidth / 2, y: totalHeight / 2, align: 'center', baseline: 'middle' }
        case 'middle-right':
          return { x: totalWidth - padding, y: totalHeight / 2, align: 'right', baseline: 'middle' }
        case 'bottom-left':
          return { x: padding, y: totalHeight - padding, align: 'left', baseline: 'bottom' }
        case 'bottom-center':
          return { x: totalWidth / 2, y: totalHeight - padding, align: 'center', baseline: 'bottom' }
        case 'bottom-right':
          return { x: totalWidth - padding, y: totalHeight - padding, align: 'right', baseline: 'bottom' }
        default:
          return { x: totalWidth / 2, y: totalHeight - padding, align: 'center', baseline: 'bottom' }
      }
    }
    
    // 准备水印和EXIF信息
    const exifValues = selectedExifFields
      .map(field => availableExifData[field])
      .filter(Boolean)
    
    const hasWatermark = watermarkSettings.text
    const hasExif = exifValues.length > 0
    const samePosition = hasWatermark && hasExif && watermarkSettings.position === exifSettings.position
    
    // 计算字体大小和间距
    const watermarkFontSize = hasWatermark ? originalHeight * (watermarkSettings.fontSizePercent / 100) * scale : 0
    const exifFontSize = hasExif ? originalHeight * (exifSettings.fontSizePercent / 100) * scale : 0
    const spacing = Math.max(watermarkFontSize, exifFontSize) * 1.3
    
    // 绘制水印文字
    if (hasWatermark) {
      const coords = getPositionCoords(watermarkSettings.position)
      let adjustedY = coords.y
      
      // 如果在同一位置，水印需要为EXIF让出空间
      if (samePosition) {
        if (watermarkSettings.position.startsWith('top-')) {
          adjustedY = coords.y
        } else if (watermarkSettings.position.startsWith('bottom-')) {
          adjustedY = coords.y - spacing
        } else {
          adjustedY = coords.y - spacing / 2
        }
      }
      
      ctx.font = `${watermarkFontSize}px ${watermarkSettings.fontFamily}`
      ctx.fillStyle = watermarkSettings.color
      ctx.textAlign = coords.align
      ctx.textBaseline = coords.baseline
      ctx.fillText(watermarkSettings.text, coords.x, adjustedY)
    }
    
    // 绘制EXIF信息
    if (hasExif) {
      const coords = getPositionCoords(exifSettings.position)
      let adjustedY = coords.y
      
      // 如果在同一位置，EXIF在水印下方
      if (samePosition) {
        if (exifSettings.position.startsWith('top-')) {
          adjustedY = coords.y - spacing
        } else if (exifSettings.position.startsWith('bottom-')) {
          adjustedY = coords.y
        } else {
          adjustedY = coords.y + spacing / 2
        }
      }
      
      ctx.font = `${exifFontSize}px ${getActualExifFont()}`
      ctx.fillStyle = watermarkSettings.color
      ctx.textAlign = coords.align
      ctx.textBaseline = coords.baseline
      ctx.fillText(exifValues.join('  '), coords.x, adjustedY)
    }

    // 恢复透明度
    ctx.globalAlpha = 1
  }

  return {
    zoomLevel,
    panX,
    panY,
    isDragging,
    handleWheel,
    startDrag,
    handleDrag,
    endDrag,
    resetZoom,
    drawFrame
  }
} 