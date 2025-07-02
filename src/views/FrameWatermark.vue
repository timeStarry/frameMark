<template>
  <div class="frame-watermark">
    <div class="container">
      <h1 class="page-title">边框水印工具</h1>
      
      <div class="main-content">
        <!-- 左侧控制面板 -->
        <div class="control-panel">
          <div class="control-card">
            <!-- 图片上传 -->
            <div class="upload-section">
              <h3>选择图片</h3>
              <div class="upload-area" @click="triggerFileInput">
                <input 
                  ref="fileInput" 
                  type="file" 
                  accept="image/*" 
                  @change="handleImageUpload"
                  style="display: none;"
                >
                <div v-if="!selectedImage" class="upload-placeholder">
                  <div class="upload-icon">📁</div>
                  <p>点击选择图片或拖拽图片到此处</p>
                  <p class="upload-hint">支持 JPG、PNG、WEBP 格式</p>
                </div>
                <div v-else class="uploaded-image">
                  <img :src="selectedImage.preview" alt="已选择的图片">
                  <button @click.stop="removeImage" class="remove-btn">✕</button>
                </div>
              </div>
            </div>

            <!-- 边框设置 -->
            <div class="settings-section" v-if="selectedImage">
              <div class="section-header" @click="toggleSection('frame')">
                <h3>边框设置</h3>
                <span class="toggle-icon" :class="{ collapsed: !sectionsOpen.frame }">▼</span>
              </div>
              
              <div v-show="sectionsOpen.frame" class="section-content">
                <div class="form-group">
                  <label>边框类型</label>
                  <select v-model="frameSettings.type">
                    <option value="blur">模糊边框</option>
                    <option value="solid">纯色边框</option>
                    <option value="gradient">渐变边框</option>
                    <option value="bottom-bar">底部条纹</option>
                  </select>
                </div>

                <div class="form-group">
                  <label>边框宽度: {{ frameSettings.widthPercent }}%</label>
                  <input 
                    type="range" 
                    v-model="frameSettings.widthPercent" 
                    min="3" 
                    max="15" 
                    step="0.5"
                  >
                </div>

                <div class="form-group">
                  <label>圆角大小: {{ frameSettings.borderRadiusPercent }}%</label>
                  <input 
                    type="range" 
                    v-model="frameSettings.borderRadiusPercent" 
                    min="0" 
                    max="5" 
                    step="0.2"
                  >
                </div>

                <div class="form-group" v-if="frameSettings.type === 'solid' || frameSettings.type === 'gradient'">
                  <label>边框颜色</label>
                  <input type="color" v-model="frameSettings.color">
                </div>

                <div class="form-group" v-if="frameSettings.type === 'blur'">
                  <label>毛玻璃强度: {{ 
                    frameSettings.blurIntensity < 15 ? '轻微' : 
                    frameSettings.blurIntensity < 30 ? '中等' : 
                    frameSettings.blurIntensity < 45 ? '强烈' : '极致' 
                  }}</label>
                  <input 
                    type="range" 
                    v-model="frameSettings.blurIntensity" 
                    min="5" 
                    max="50" 
                    step="1"
                  >
                  <div class="range-labels">
                    <span>轻微</span>
                    <span>极致</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 水印设置 -->
            <div class="settings-section" v-if="selectedImage">
              <div class="section-header" @click="toggleSection('watermark')">
                <h3>水印设置</h3>
                <span class="toggle-icon" :class="{ collapsed: !sectionsOpen.watermark }">▼</span>
              </div>
              
              <div v-show="sectionsOpen.watermark" class="section-content">
                <div class="form-group">
                  <label>水印文字</label>
                  <textarea 
                    v-model="watermarkSettings.text" 
                    rows="3" 
                    placeholder="输入水印文字内容"
                  ></textarea>
                </div>

                <div class="form-group">
                  <label>文字字体</label>
                  <select v-model="watermarkSettings.fontFamily">
                    <optgroup label="签名艺术体">
                      <option value="Dancing Script">Dancing Script</option>
                      <option value="Pacifico">Pacifico</option>
                      <option value="Kaushan Script">Kaushan Script</option>
                      <option value="Great Vibes">Great Vibes</option>
                      <option value="Allura">Allura</option>
                    </optgroup>
                    <optgroup label="现代艺术体">
                      <option value="Lobster">Lobster</option>
                      <option value="Fredoka One">Fredoka One</option>
                      <option value="Comfortaa">Comfortaa</option>
                      <option value="Righteous">Righteous</option>
                      <option value="Bungee">Bungee</option>
                    </optgroup>
                    <optgroup label="优雅衬线体">
                      <option value="Playfair Display">Playfair Display</option>
                      <option value="Cormorant Garamond">Cormorant Garamond</option>
                      <option value="Crimson Text">Crimson Text</option>
                      <option value="Lora">Lora</option>
                      <option value="Merriweather">Merriweather</option>
                    </optgroup>
                    <optgroup label="中文书法体">
                      <option value="ZCOOL XiaoWei">ZCOOL 小微</option>
                      <option value="Ma Shan Zheng">马善政楷书</option>
                    </optgroup>
                    <optgroup label="系统字体">
                      <option value="微软雅黑">微软雅黑</option>
                      <option value="Arial">Arial</option>
                      <option value="Times New Roman">Times New Roman</option>
                    </optgroup>
                  </select>
                </div>

                <div class="form-group" v-if="selectedExifFields.length > 0">
                  <label>EXIF 数据字体</label>
                  <select v-model="exifSettings.fontFamily">
                    <optgroup label="现代简约风格">
                      <option value="Inter">Inter</option>
                      <option value="IBM Plex Sans">IBM Plex Sans</option>
                      <option value="Source Sans Pro">Source Sans Pro</option>
                      <option value="Roboto">Roboto</option>
                      <option value="Open Sans">Open Sans</option>
                    </optgroup>
                    <optgroup label="专业等宽体">
                      <option value="JetBrains Mono">JetBrains Mono</option>
                      <option value="Fira Code">Fira Code</option>
                      <option value="Source Code Pro">Source Code Pro</option>
                      <option value="Roboto Mono">Roboto Mono</option>
                      <option value="IBM Plex Mono">IBM Plex Mono</option>
                    </optgroup>
                    <optgroup label="简洁无衬线体">
                      <option value="Lato">Lato</option>
                      <option value="Nunito Sans">Nunito Sans</option>
                      <option value="Work Sans">Work Sans</option>
                      <option value="Noto Sans">Noto Sans</option>
                    </optgroup>
                  </select>
                </div>

                <div class="form-group">
                  <label>字体大小: {{ watermarkSettings.fontSizePercent }}%</label>
                  <input 
                    type="range" 
                    v-model="watermarkSettings.fontSizePercent" 
                    min="1" 
                    max="8" 
                    step="0.2"
                  >
                </div>

                <div class="form-group">
                  <label>字体颜色</label>
                  <input type="color" v-model="watermarkSettings.color">
                </div>

                <div class="form-group">
                  <label>透明度: {{ Math.round(watermarkSettings.opacity * 100) }}%</label>
                  <input 
                    type="range" 
                    v-model="watermarkSettings.opacity" 
                    min="0.1" 
                    max="1" 
                    step="0.1"
                  >
                </div>

                <div class="form-group">
                  <label>位置</label>
                  <select v-model="watermarkSettings.position">
                    <option value="bottom-left">左下角</option>
                    <option value="bottom-right">右下角</option>
                    <option value="bottom-center">底部居中</option>
                    <option value="top-left">左上角</option>
                    <option value="top-right">右上角</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- EXIF信息 -->
            <div class="settings-section" v-if="selectedImage && Object.keys(availableExifData).length > 0">
              <div class="section-header" @click="toggleSection('exif')">
                <h3>EXIF信息</h3>
                <span class="toggle-icon" :class="{ collapsed: !sectionsOpen.exif }">▼</span>
              </div>
              
              <div v-show="sectionsOpen.exif" class="section-content">
                <div class="form-group">
                  <label>EXIF 字体大小: {{ exifSettings.fontSizePercent }}%</label>
                  <input 
                    type="range" 
                    v-model="exifSettings.fontSizePercent" 
                    min="1" 
                    max="6" 
                    step="0.2"
                  >
                </div>
                
                <div class="exif-grid">
                  <label v-for="(value, key) in availableExifData" :key="key" class="exif-checkbox">
                    <input 
                      type="checkbox" 
                      :value="key" 
                      v-model="selectedExifFields"
                    >
                    <span class="exif-label">{{ formatExifDisplay(key, value) }}</span>
                  </label>
                </div>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="actions" v-if="selectedImage">
              <button @click="generateAndDownload" class="btn btn-primary" :disabled="isProcessing">
                <span v-if="isProcessing">生成中...</span>
                <span v-else>生成并下载</span>
              </button>
              <button @click="resetAll" class="btn btn-outline">
                重置页面
              </button>
            </div>
          </div>
        </div>

        <!-- 右侧预览区域 -->
        <div class="preview-panel">
          <div class="preview-header">
            <div>
              <h3>实时预览</h3>
              <p class="preview-tip" v-if="selectedImage">预览为缩放显示，实际导出为高清原图</p>
            </div>
            <div class="preview-controls" v-if="selectedImage">
              <button @click="resetZoom" class="zoom-btn" title="重置缩放">
                🔍
              </button>
              <span class="zoom-level">{{ Math.round(zoomLevel * 100) }}%</span>
            </div>
          </div>
          
          <div class="preview-viewport" 
               @wheel="handleWheel"
               @mousedown="startDrag"
               @mousemove="handleDrag"
               @mouseup="endDrag"
               @mouseleave="endDrag">
            <div v-if="!selectedImage" class="preview-placeholder">
              <div class="placeholder-icon">🖼️</div>
              <p>请先选择一张图片</p>
            </div>
            <div v-else class="preview-container"
                 :style="{ 
                   transform: `scale(${zoomLevel}) translate(${panX}px, ${panY}px)`,
                   cursor: isDragging ? 'grabbing' : 'grab'
                 }">
              <canvas 
                ref="previewCanvas" 
                class="preview-canvas"
              ></canvas>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, watch, nextTick } from 'vue'
import { extractExifData } from '@/utils/exifUtils'
import { downloadBlob } from '@/utils/fileUtils'

// 响应式数据
const fileInput = ref(null)
const previewCanvas = ref(null)
const selectedImage = ref(null)
const processedImage = ref(null)
const exifData = ref(null)
const selectedExifFields = ref([])
const isProcessing = ref(false)

// 预览控制
const zoomLevel = ref(1)
const panX = ref(0)
const panY = ref(0)
const isDragging = ref(false)
const lastMousePos = ref({ x: 0, y: 0 })

// 折叠状态
const sectionsOpen = reactive({
  frame: true,
  watermark: true,
  exif: true
})

// 边框设置 - 使用百分比
const frameSettings = reactive({
  type: 'blur',
  widthPercent: 8, // 8% of image size
  borderRadiusPercent: 1.5, // 1.5% of image size
  color: '#ffffff',
  blurIntensity: 35 // 强烈毛玻璃效果作为默认
})

// 水印设置 - 使用百分比
const watermarkSettings = reactive({
  text: 'Shot with iPhone',
  fontFamily: 'Dancing Script', // 优雅的签名体
  fontSizePercent: 2.5, // 2.5% of image height
  color: '#ffffff',
  opacity: 0.9,
  position: 'bottom-center' // 修改默认位置为底部居中
})

// EXIF字体设置
const exifSettings = reactive({
  fontFamily: 'Inter', // 现代简约风格
  fontSizePercent: 2.0 // EXIF字体大小，稍小于主文字
})

// 计算属性
const availableExifData = ref({})

// EXIF字段标签映射
const exifLabels = {
  Make: '品牌',
  Model: '型号',
  LensModel: '镜头',
  FNumber: '光圈',
  ExposureTime: '快门',
  ISO: 'ISO',
  FocalLength: '焦距',
  DateTime: '📅',
  Flash: '闪光灯',
  WhiteBalance: '白平衡'
}

// 默认选中的EXIF字段
const defaultExifFields = ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']

// 方法
const toggleSection = (section) => {
  sectionsOpen[section] = !sectionsOpen[section]
}

const triggerFileInput = () => {
  fileInput.value.click()
}

// 预览控制方法
const handleWheel = (event) => {
  if (!selectedImage.value) return
  
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.1 : 0.1
  zoomLevel.value = Math.max(0.1, Math.min(3, zoomLevel.value + delta))
}

const startDrag = (event) => {
  if (!selectedImage.value) return
  
  isDragging.value = true
  lastMousePos.value = { x: event.clientX, y: event.clientY }
}

const handleDrag = (event) => {
  if (!isDragging.value || !selectedImage.value) return
  
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

const resetAll = () => {
  if (confirm('确定要重置所有设置吗？')) {
    removeImage()
    resetZoom()
    // 重置所有设置到默认值
    frameSettings.type = 'blur'
    frameSettings.widthPercent = 8
    frameSettings.borderRadiusPercent = 1.5
    frameSettings.color = '#ffffff'
    frameSettings.blurIntensity = 35 // 强烈毛玻璃效果作为默认
    
    watermarkSettings.text = 'Shot with iPhone'
    watermarkSettings.fontFamily = 'Dancing Script'
    watermarkSettings.fontSizePercent = 2.5
    watermarkSettings.color = '#ffffff'
    watermarkSettings.opacity = 0.9
    watermarkSettings.position = 'bottom-center'
    
    exifSettings.fontFamily = 'Inter'
    exifSettings.fontSizePercent = 2.0
    
    sectionsOpen.frame = true
    sectionsOpen.watermark = true
    sectionsOpen.exif = true
  }
}

const handleImageUpload = async (event) => {
  const file = event.target.files[0]
  if (!file) return

  try {
    // 创建图片预览
    const preview = URL.createObjectURL(file)
    selectedImage.value = {
      file,
      preview,
      name: file.name
    }

    // 重置预览控制
    resetZoom()

    // 提取EXIF数据
    const exif = await extractExifData(file)
    exifData.value = exif
    
    // 过滤可用的EXIF数据
    availableExifData.value = {}
    Object.keys(exifLabels).forEach(key => {
      if (exif[key]) {
        availableExifData.value[key] = formatExifValue(key, exif[key])
      }
    })

    // 默认选中常用EXIF字段
    selectedExifFields.value = defaultExifFields.filter(field => 
      availableExifData.value[field]
    )

    // 等待DOM更新后生成预览
    await nextTick()
    generatePreview()
  } catch (error) {
    console.error('图片处理失败:', error)
    alert('图片处理失败，请重试')
  }
}

const removeImage = () => {
  if (selectedImage.value?.preview) {
    URL.revokeObjectURL(selectedImage.value.preview)
  }
  selectedImage.value = null
  processedImage.value = null
  exifData.value = null
  availableExifData.value = {}
  selectedExifFields.value = []
}

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
      return new Date(value).toLocaleDateString('zh-CN')
    default:
      return value
  }
}

const formatExifDisplay = (key, value) => {
  // 直接显示格式化后的值，不加前缀
  return value
}

const generatePreview = () => {
  if (!selectedImage.value || !previewCanvas.value) return

  const canvas = previewCanvas.value
  const ctx = canvas.getContext('2d')
  const img = new Image()

  img.onload = () => {
    // 设置画布尺寸 - 保持原图比例，提高预览质量
    const maxDisplayWidth = 800
    const maxDisplayHeight = 600
    const aspectRatio = img.width / img.height

    let displayWidth, displayHeight
    if (aspectRatio > maxDisplayWidth / maxDisplayHeight) {
      displayWidth = maxDisplayWidth
      displayHeight = maxDisplayWidth / aspectRatio
    } else {
      displayHeight = maxDisplayHeight
      displayWidth = maxDisplayHeight * aspectRatio
    }

    canvas.width = displayWidth
    canvas.height = displayHeight

    // 绘制边框和图片 - 使用与实际生成相同的逻辑
    drawFrame(ctx, displayWidth, displayHeight, img, img.width, img.height)
  }

  img.src = selectedImage.value.preview
}

const drawFrame = (ctx, canvasWidth, canvasHeight, img, originalWidth, originalHeight) => {
  // 清空画布
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

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
    drawBlurFrame(ctx, totalWidth, totalHeight, scaledFrameWidth, img, scaledImageWidth, scaledImageHeight)
  } else if (frameSettings.type === 'solid') {
    ctx.fillStyle = frameSettings.color
    drawRoundedRect(ctx, 0, 0, totalWidth, totalHeight, scaledBorderRadius)
  } else if (frameSettings.type === 'gradient') {
    const gradient = ctx.createLinearGradient(0, 0, totalWidth, totalHeight)
    gradient.addColorStop(0, frameSettings.color)
    gradient.addColorStop(1, '#000000')
    ctx.fillStyle = gradient
    drawRoundedRect(ctx, 0, 0, totalWidth, totalHeight, scaledBorderRadius)
  } else if (frameSettings.type === 'bottom-bar') {
    ctx.fillStyle = '#ffffff'
    drawRoundedRect(ctx, 0, 0, totalWidth, totalHeight, scaledBorderRadius)
  }

  // 绘制主图片
  const imageX = scaledFrameWidth
  const imageY = scaledFrameWidth

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(imageX, imageY, scaledImageWidth, scaledImageHeight, scaledBorderRadius)
  ctx.clip()
  ctx.drawImage(img, imageX, imageY, scaledImageWidth, scaledImageHeight)
  ctx.restore()

  // 绘制水印 - 在边框区域
  drawWatermark(ctx, totalWidth, totalHeight, scaledFrameWidth, originalWidth, originalHeight, scale)
  
  ctx.restore()
}

const drawBlurFrame = (ctx, totalWidth, totalHeight, frameWidth, img, imageWidth, imageHeight) => {
  // 计算实际模糊值 - 修正度量逻辑，轻微=小数值，极致=大数值
  // 扩大模糊范围，最大可达80px
  const actualBlur = Math.max(2, frameSettings.blurIntensity * 1.6)
  
  // 创建高质量毛玻璃效果，保持原色调
  // 第一层：基础模糊背景，保持原始色调
  const baseCanvas = document.createElement('canvas')
  const baseCtx = baseCanvas.getContext('2d')
  baseCanvas.width = totalWidth
  baseCanvas.height = totalHeight
  
  // 应用基础模糊，微调对比度和饱和度，不调整亮度
  baseCtx.filter = `blur(${actualBlur}px) contrast(0.98) saturate(1.05)`
  baseCtx.drawImage(img, 0, 0, totalWidth, totalHeight)
  
  // 第二层：增强模糊深度
  const enhancedCanvas = document.createElement('canvas')
  const enhancedCtx = enhancedCanvas.getContext('2d')
  enhancedCanvas.width = totalWidth
  enhancedCanvas.height = totalHeight
  
  // 多重模糊处理，创造深度感
  enhancedCtx.filter = `blur(${actualBlur * 0.6}px)`
  enhancedCtx.drawImage(baseCanvas, 0, 0)
  
  // 第三重模糊，让高强度时内容更不可辨识
  if (frameSettings.blurIntensity > 30) {
    const deepBlurCanvas = document.createElement('canvas')
    const deepBlurCtx = deepBlurCanvas.getContext('2d')
    deepBlurCanvas.width = totalWidth
    deepBlurCanvas.height = totalHeight
    
    const extraBlur = (frameSettings.blurIntensity - 30) * 1.5
    deepBlurCtx.filter = `blur(${extraBlur}px)`
    deepBlurCtx.drawImage(enhancedCanvas, 0, 0)
    
    // 混合两层，创造更强的模糊效果
    enhancedCtx.globalCompositeOperation = 'normal'
    enhancedCtx.globalAlpha = 0.7
    enhancedCtx.drawImage(deepBlurCanvas, 0, 0)
    enhancedCtx.globalAlpha = 1
  }
  
  // 第三层：微妙的质感调整，保持色调一致
  const finalCanvas = document.createElement('canvas')
  const finalCtx = finalCanvas.getContext('2d')
  finalCanvas.width = totalWidth
  finalCanvas.height = totalHeight
  
  // 绘制增强模糊层
  finalCtx.drawImage(enhancedCanvas, 0, 0)
  
  // 只在极高强度时添加非常轻微的暗化效果，符合毛玻璃特性
  if (frameSettings.blurIntensity > 45) {
    finalCtx.globalCompositeOperation = 'multiply'
    finalCtx.fillStyle = `rgba(250, 248, 246, 0.97)` // 使用接近莫兰蒂色调的暗化
    finalCtx.fillRect(0, 0, totalWidth, totalHeight)
  }
  
  // 将最终的毛玻璃背景绘制到主画布
  ctx.drawImage(finalCanvas, 0, 0)
}

const drawRoundedRect = (ctx, x, y, width, height, radius) => {
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
  ctx.fill()
}

const drawWatermark = (ctx, totalWidth, totalHeight, frameWidth, originalWidth, originalHeight, scale) => {
  if (!watermarkSettings.text && selectedExifFields.value.length === 0) return

  // 设置透明度
  ctx.globalAlpha = watermarkSettings.opacity
  
  // 构建水印文本
  let lines = []
  
  // 添加自定义文字水印
  if (watermarkSettings.text) {
    ctx.fillStyle = watermarkSettings.color
    const fontSize = originalHeight * (watermarkSettings.fontSizePercent / 100) * scale
    ctx.font = `${fontSize}px ${watermarkSettings.fontFamily}`
    lines.push({
      text: watermarkSettings.text,
      font: `${fontSize}px ${watermarkSettings.fontFamily}`,
      color: watermarkSettings.color
    })
  }
  
  // 添加选中的EXIF信息 - 使用不同字体
  const exifValues = selectedExifFields.value
    .map(field => availableExifData.value[field])
    .filter(Boolean)
  
  if (exifValues.length > 0) {
    const exifFontSize = originalHeight * (exifSettings.fontSizePercent / 100) * scale // 使用独立的字体大小设置
    lines.push({
      text: exifValues.join('  '),
      font: `${exifFontSize}px ${exifSettings.fontFamily}`,
      color: watermarkSettings.color
    })
  }

  // 计算文本位置 - 在边框区域内
  const padding = frameWidth * 0.3
  const lineHeight = (originalHeight * (watermarkSettings.fontSizePercent / 100) * scale) * 1.3
  let x, y

  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'

  switch (watermarkSettings.position) {
    case 'bottom-left':
      x = padding
      y = totalHeight - padding
      break
    case 'bottom-right':
      ctx.textAlign = 'right'
      x = totalWidth - padding
      y = totalHeight - padding
      break
    case 'bottom-center':
      ctx.textAlign = 'center'
      x = totalWidth / 2
      y = totalHeight - padding
      break
    case 'top-left':
      x = padding
      y = frameWidth - padding
      break
    case 'top-right':
      ctx.textAlign = 'right'
      x = totalWidth - padding
      y = frameWidth - padding
      break
  }

  // 绘制每行文本，使用各自的字体
  lines.forEach((line, index) => {
    ctx.font = line.font
    ctx.fillStyle = line.color
    const lineY = watermarkSettings.position.includes('bottom') 
      ? y - (lines.length - 1 - index) * lineHeight
      : y + (index + 1) * lineHeight
    ctx.fillText(line.text, x, lineY)
  })

  // 恢复透明度
  ctx.globalAlpha = 1
}

const generateAndDownload = async () => {
  if (!selectedImage.value || isProcessing.value) return

  isProcessing.value = true
  
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()

    await new Promise((resolve, reject) => {
      img.onload = () => {
        try {
          // 使用原始图片尺寸加上边框
          const frameWidth = Math.min(img.width, img.height) * (frameSettings.widthPercent / 100)
          canvas.width = img.width + frameWidth * 2
          canvas.height = img.height + frameWidth * 2

          // 绘制高质量图片 - 使用与预览相同的逻辑
          drawFrame(ctx, canvas.width, canvas.height, img, img.width, img.height)

          // 转换为blob并下载
          canvas.toBlob((blob) => {
            const fileName = `${selectedImage.value.name.split('.')[0]}_watermarked.png`
            downloadBlob(blob, fileName)
            resolve()
          }, 'image/png', 1.0)
        } catch (error) {
          reject(error)
        }
      }
      img.onerror = reject
      img.src = selectedImage.value.preview
    })
  } catch (error) {
    console.error('生成图片失败:', error)
    alert('生成图片失败，请重试')
  } finally {
    isProcessing.value = false
  }
}

// 监听设置变化，自动更新预览
watch([frameSettings, watermarkSettings, exifSettings, selectedExifFields], () => {
  if (selectedImage.value) {
    generatePreview()
  }
}, { deep: true })
</script>

<style scoped>
.frame-watermark {
  padding: 40px 20px;
}





.main-content {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 24px;
  align-items: start;
  min-height: calc(100vh - 240px);
}

.control-panel {
  position: sticky;
  top: 100px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  
  &::-webkit-scrollbar {
    width: 6px;
  }
  
  &::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
  }
  
  &::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.3);
    border-radius: 3px;
    
    &:hover {
      background: rgba(255, 255, 255, 0.5);
    }
  }
}

.control-card {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
}

.upload-section {
  margin-bottom: 30px;
  
  h3 {
    color: white;
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
  }
}

  .upload-area {
    border: 2px dashed rgba(255, 255, 255, 0.4);
    border-radius: 12px;
    padding: 40px 20px;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s ease;
    background: rgba(255, 255, 255, 0.05);
    
    &:hover {
      border-color: rgba(255, 255, 255, 0.6);
      background: rgba(255, 255, 255, 0.1);
    }
  }

.upload-placeholder {
  color: rgba(255, 255, 255, 0.8);
  
  p {
    color: rgba(255, 255, 255, 0.9);
    font-weight: 500;
  }
}

.upload-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.upload-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 8px;
}

.uploaded-image {
  position: relative;
  
  img {
    max-width: 100%;
    max-height: 200px;
    border-radius: 6px;
    object-fit: cover;
  }
}

.remove-btn {
  position: absolute;
  top: -10px;
  right: -10px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #ff4757;
  color: white;
  border: none;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  
  &:hover {
    background: #ff3838;
    transform: scale(1.1);
  }
}

.settings-section {
  margin-bottom: 30px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.section-header {
  padding: 16px 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  transition: all 0.2s ease;
  
  &:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  
  h3 {
    color: white;
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }
}

.toggle-icon {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  transition: transform 0.2s ease;
  
  &.collapsed {
    transform: rotate(-90deg);
  }
}

.section-content {
  padding: 0 20px 20px;
}

  .form-group {
    margin-bottom: 20px;
    
    label {
      display: block;
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
    }
    
    .range-labels {
      display: flex;
      justify-content: space-between;
      margin-top: 8px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.6);
    }
  
  input, select, textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    font-size: 14px;
    transition: all 0.2s ease;
    
    &:focus {
      outline: none;
      border-color: #a18875;
      background: rgba(255, 255, 255, 0.15);
    }
    
    &::placeholder {
      color: rgba(255, 255, 255, 0.5);
    }
  }
  
  select {
    cursor: pointer;
    
    option {
      background: #5d5148;
      color: white;
    }
  }
  
      input[type="range"] {
      width: 100%;
      height: 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.2);
      outline: none;
      -webkit-appearance: none;
      padding: 0;
      
      &::-webkit-slider-thumb {
        appearance: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #a18875;
        cursor: pointer;
        border: 2px solid white;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      
      &::-moz-range-thumb {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #a18875;
        cursor: pointer;
        border: 2px solid white;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
    }
}

.exif-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

  .exif-checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    padding: 8px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    transition: all 0.3s ease;
    color: rgba(255, 255, 255, 0.9);
    
    &:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.4);
    }
  
  input[type="checkbox"] {
    width: auto;
    margin: 0;
    accent-color: #a18875;
  }
}

.exif-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions {
  display: flex;
  gap: 12px;
  flex-direction: column;
  margin-top: 20px;
}

.preview-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

  .preview-header {
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 16px 16px 0 0;
    padding: 20px 24px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    
    > div:first-child {
      flex: 1;
    }
    
    h3 {
      color: white;
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 8px 0;
    }
  }



.preview-tip {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  margin: 0;
}

.preview-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.zoom-btn {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  border-radius: 6px;
  padding: 8px;
  color: white;
  cursor: pointer;
  font-size: 16px;
  transition: all 0.3s ease;
  
  &:hover {
    background: rgba(255, 255, 255, 0.3);
  }
}

.zoom-level {
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
  min-width: 50px;
  text-align: center;
}

.preview-viewport {
  flex: 1;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-top: none;
  border-radius: 0 0 16px 16px;
  padding: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 500px;
  overflow: hidden;
  position: relative;
  user-select: none;
}

.preview-placeholder {
  text-align: center;
  color: rgba(255, 255, 255, 0.7);
  
  p {
    color: rgba(255, 255, 255, 0.8);
    font-weight: 500;
    margin-top: 16px;
  }
}

.placeholder-icon {
  font-size: 64px;
  margin-bottom: 16px;
  opacity: 0.8;
}

.preview-container {
  transition: transform 0.1s ease-out;
  transform-origin: center;
}

.preview-canvas {
  display: block;
  max-width: none;
  max-height: none;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

@media (max-width: 1000px) {
  .main-content {
    grid-template-columns: 300px 1fr;
  }
}

@media (max-width: 768px) {
  .main-content {
    grid-template-columns: 1fr;
    gap: 20px;
    min-height: auto;
  }
  
  .control-panel {
    position: static;
    max-height: none;
    height: auto;
    overflow-y: visible;
  }
  
  .actions {
    flex-direction: row;
  }
  
  .exif-grid {
    grid-template-columns: 1fr 1fr;
  }
  
  .preview-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    
    > div:first-child {
      width: 100%;
    }
    
    .preview-controls {
      align-self: flex-end;
    }
  }
  
  .preview-controls {
    gap: 8px;
  }
}
</style> 