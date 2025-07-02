<template>
  <div class="image-collage">
    <div class="container">
      <h1 class="page-title">图片拼图工具</h1>
      
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
                  multiple
                  @change="handleImageUpload"
                  style="display: none;"
                >
                <div class="upload-placeholder">
                  <div class="upload-icon">📁</div>
                  <p>点击选择多张图片或拖拽图片到此处</p>
                  <p class="upload-hint">支持选择多张图片进行拼图</p>
                </div>
              </div>
              
              <!-- 已选择的图片列表 -->
              <div v-if="selectedImages.length > 0" class="selected-images">
                <h4>已选择 {{ selectedImages.length }} 张图片</h4>
                <div class="image-list">
                  <div 
                    v-for="(image, index) in selectedImages" 
                    :key="index"
                    class="image-item"
                    draggable="true"
                    @dragstart="handleDragStart(index)"
                    @dragover.prevent
                    @drop="handleDrop(index)"
                  >
                    <img :src="image.preview" :alt="`图片 ${index + 1}`">
                    <button @click="removeImage(index)" class="remove-btn">✕</button>
                    <div class="drag-handle">⋮⋮</div>
                  </div>
                </div>
                <button @click="clearAllImages" class="btn btn-secondary btn-small">
                  清空所有图片
                </button>
              </div>
            </div>

            <!-- 布局设置 -->
            <div class="settings-section" v-if="selectedImages.length > 0">
              <div class="section-header" @click="toggleSection('layout')">
                <h3>布局设置</h3>
                <span class="toggle-icon" :class="{ collapsed: !sectionsOpen.layout }">▼</span>
              </div>
              
              <div v-show="sectionsOpen.layout" class="section-content">
              
              <div class="form-group">
                <label>布局模式</label>
                <select v-model="layoutSettings.mode">
                  <option value="grid">网格布局</option>
                  <option value="horizontal">水平拼接</option>
                  <option value="vertical">垂直拼接</option>
                  <option value="masonry">瀑布流</option>
                </select>
              </div>

              <div class="form-group" v-if="layoutSettings.mode === 'grid'">
                <label>网格列数: {{ layoutSettings.columns }}</label>
                <input 
                  type="range" 
                  v-model="layoutSettings.columns" 
                  min="1" 
                  :max="Math.min(selectedImages.length, 6)"
                  step="1"
                >
              </div>

              <div class="form-group">
                <label>图片间隔: {{ layoutSettings.gap }}px</label>
                <input 
                  type="range" 
                  v-model="layoutSettings.gap" 
                  min="0" 
                  max="50" 
                  step="2"
                >
              </div>

              <div class="form-group">
                <label>背景颜色</label>
                <input type="color" v-model="layoutSettings.backgroundColor">
              </div>

              <div class="form-group">
                <label>圆角大小: {{ layoutSettings.borderRadius }}px</label>
                <input 
                  type="range" 
                  v-model="layoutSettings.borderRadius" 
                  min="0" 
                  max="30" 
                  step="2"
                >
              </div>

              <div class="form-group">
                <label>输出尺寸</label>
                <select v-model="layoutSettings.outputSize">
                  <option value="auto">自适应</option>
                  <option value="1080x1080">1080x1080 (正方形)</option>
                  <option value="1080x1920">1080x1920 (竖屏)</option>
                  <option value="1920x1080">1920x1080 (横屏)</option>
                  <option value="custom">自定义</option>
                </select>
              </div>

              <div v-if="layoutSettings.outputSize === 'custom'" class="custom-size">
                <div class="form-group">
                  <label>宽度</label>
                  <input type="number" v-model="layoutSettings.customWidth" min="100" max="4000">
                </div>
                <div class="form-group">
                  <label>高度</label>
                  <input type="number" v-model="layoutSettings.customHeight" min="100" max="4000">
                </div>
              </div>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="actions" v-if="selectedImages.length > 0">
              <button @click="generateCollage" class="btn btn-primary">
                生成拼图
              </button>
              <button @click="downloadCollage" class="btn btn-secondary" v-if="processedCollage">
                下载拼图
              </button>
            </div>
          </div>
        </div>

        <!-- 右侧预览区域 -->
        <div class="preview-panel">
          <div class="preview-header">
            <h3>预览效果</h3>
            <p class="preview-hint">预览为缩放显示，实际导出为高清原图</p>
          </div>
          <div class="preview-viewport">
              <div v-if="selectedImages.length === 0" class="preview-placeholder">
                <div class="placeholder-icon">🧩</div>
                <p>请先选择图片开始拼图</p>
              </div>
              <div v-else class="preview-collage-container">
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
import { downloadBlob } from '@/utils/fileUtils'

// 响应式数据
const fileInput = ref(null)
const previewCanvas = ref(null)
const selectedImages = ref([])
const processedCollage = ref(null)
const draggedIndex = ref(null)

// 折叠状态管理
const sectionsOpen = reactive({
  layout: true
})

// 布局设置
const layoutSettings = reactive({
  mode: 'grid',
  columns: 2,
  gap: 10,
  backgroundColor: '#ffffff',
  borderRadius: 8,
  outputSize: 'auto',
  customWidth: 1080,
  customHeight: 1080
})

// 方法
const toggleSection = (section) => {
  sectionsOpen[section] = !sectionsOpen[section]
}

const triggerFileInput = () => {
  fileInput.value.click()
}

const handleImageUpload = async (event) => {
  const files = Array.from(event.target.files)
  if (!files.length) return

  try {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      
      const preview = URL.createObjectURL(file)
      selectedImages.value.push({
        file,
        preview,
        name: file.name,
        id: Date.now() + Math.random()
      })
    }

    // 清空文件输入
    fileInput.value.value = ''

    // 生成预览
    await nextTick()
    generatePreview()
  } catch (error) {
    console.error('图片处理失败:', error)
    alert('图片处理失败，请重试')
  }
}

const removeImage = (index) => {
  const image = selectedImages.value[index]
  if (image?.preview) {
    URL.revokeObjectURL(image.preview)
  }
  selectedImages.value.splice(index, 1)
  generatePreview()
}

const clearAllImages = () => {
  selectedImages.value.forEach(image => {
    if (image.preview) {
      URL.revokeObjectURL(image.preview)
    }
  })
  selectedImages.value = []
  processedCollage.value = null
}

const handleDragStart = (index) => {
  draggedIndex.value = index
}

const handleDrop = (dropIndex) => {
  if (draggedIndex.value === null || draggedIndex.value === dropIndex) return

  const draggedItem = selectedImages.value[draggedIndex.value]
  selectedImages.value.splice(draggedIndex.value, 1)
  selectedImages.value.splice(dropIndex, 0, draggedItem)
  
  draggedIndex.value = null
  generatePreview()
}

const getOutputDimensions = () => {
  switch (layoutSettings.outputSize) {
    case '1080x1080':
      return { width: 1080, height: 1080 }
    case '1080x1920':
      return { width: 1080, height: 1920 }
    case '1920x1080':
      return { width: 1920, height: 1080 }
    case 'custom':
      return { 
        width: layoutSettings.customWidth, 
        height: layoutSettings.customHeight 
      }
    default:
      return calculateAutoDimensions()
  }
}

const calculateAutoDimensions = () => {
  const imageCount = selectedImages.value.length
  if (imageCount === 0) return { width: 800, height: 600 }

  const baseSize = 300
  const gap = layoutSettings.gap
  
  switch (layoutSettings.mode) {
    case 'horizontal':
      return {
        width: imageCount * baseSize + (imageCount - 1) * gap,
        height: baseSize
      }
    case 'vertical':
      return {
        width: baseSize,
        height: imageCount * baseSize + (imageCount - 1) * gap
      }
    case 'grid':
    default:
      const cols = layoutSettings.columns
      const rows = Math.ceil(imageCount / cols)
      return {
        width: cols * baseSize + (cols - 1) * gap,
        height: rows * baseSize + (rows - 1) * gap
      }
  }
}

const generatePreview = async () => {
  if (selectedImages.value.length === 0 || !previewCanvas.value) return

  const canvas = previewCanvas.value
  const ctx = canvas.getContext('2d')
  
  // 计算预览尺寸（缩放到适合预览的大小）
  const outputDimensions = getOutputDimensions()
  const previewScale = Math.min(600 / outputDimensions.width, 400 / outputDimensions.height)
  
  canvas.width = outputDimensions.width * previewScale
  canvas.height = outputDimensions.height * previewScale

  // 设置背景色
  ctx.fillStyle = layoutSettings.backgroundColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 加载所有图片
  const loadedImages = await Promise.all(
    selectedImages.value.map(imageData => loadImage(imageData.preview))
  )

  // 根据布局模式绘制图片
  drawLayout(ctx, loadedImages, previewScale)
}

const loadImage = (src) => {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

const drawLayout = (ctx, images, scale = 1) => {
  const gap = layoutSettings.gap * scale
  const borderRadius = layoutSettings.borderRadius * scale
  
  switch (layoutSettings.mode) {
    case 'horizontal':
      drawHorizontalLayout(ctx, images, gap, borderRadius)
      break
    case 'vertical':
      drawVerticalLayout(ctx, images, gap, borderRadius)
      break
    case 'grid':
    default:
      drawGridLayout(ctx, images, gap, borderRadius)
      break
  }
}

const drawGridLayout = (ctx, images, gap, borderRadius) => {
  const cols = layoutSettings.columns
  const rows = Math.ceil(images.length / cols)
  const cellWidth = (ctx.canvas.width - (cols - 1) * gap) / cols
  const cellHeight = (ctx.canvas.height - (rows - 1) * gap) / rows

  images.forEach((img, index) => {
    if (!img) return
    
    const col = index % cols
    const row = Math.floor(index / cols)
    const x = col * (cellWidth + gap)
    const y = row * (cellHeight + gap)

    drawImageWithBorderRadius(ctx, img, x, y, cellWidth, cellHeight, borderRadius)
  })
}

const drawHorizontalLayout = (ctx, images, gap, borderRadius) => {
  const cellWidth = (ctx.canvas.width - (images.length - 1) * gap) / images.length
  const cellHeight = ctx.canvas.height

  images.forEach((img, index) => {
    if (!img) return
    
    const x = index * (cellWidth + gap)
    const y = 0

    drawImageWithBorderRadius(ctx, img, x, y, cellWidth, cellHeight, borderRadius)
  })
}

const drawVerticalLayout = (ctx, images, gap, borderRadius) => {
  const cellWidth = ctx.canvas.width
  const cellHeight = (ctx.canvas.height - (images.length - 1) * gap) / images.length

  images.forEach((img, index) => {
    if (!img) return
    
    const x = 0
    const y = index * (cellHeight + gap)

    drawImageWithBorderRadius(ctx, img, x, y, cellWidth, cellHeight, borderRadius)
  })
}

const drawImageWithBorderRadius = (ctx, img, x, y, width, height, borderRadius) => {
  ctx.save()
  
  // 创建圆角剪切路径
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, borderRadius)
  ctx.clip()
  
  // 计算图片绘制参数以保持比例
  const imgAspect = img.width / img.height
  const cellAspect = width / height
  
  let drawWidth, drawHeight, drawX, drawY
  
  if (imgAspect > cellAspect) {
    // 图片更宽，以高度为准
    drawHeight = height
    drawWidth = height * imgAspect
    drawX = x - (drawWidth - width) / 2
    drawY = y
  } else {
    // 图片更高，以宽度为准
    drawWidth = width
    drawHeight = width / imgAspect
    drawX = x
    drawY = y - (drawHeight - height) / 2
  }
  
  ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
  ctx.restore()
}

const generateCollage = async () => {
  if (selectedImages.value.length === 0) return

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  
  // 使用实际输出尺寸
  const outputDimensions = getOutputDimensions()
  canvas.width = outputDimensions.width
  canvas.height = outputDimensions.height

  // 设置背景色
  ctx.fillStyle = layoutSettings.backgroundColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 加载所有图片
  const loadedImages = await Promise.all(
    selectedImages.value.map(imageData => loadImage(imageData.preview))
  )

  // 绘制布局
  drawLayout(ctx, loadedImages)

  // 转换为blob
  canvas.toBlob((blob) => {
    processedCollage.value = {
      blob,
      url: URL.createObjectURL(blob)
    }
  }, 'image/png', 1.0)
}

const downloadCollage = () => {
  if (!processedCollage.value) return

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
  const fileName = `collage_${timestamp}.png`
  downloadBlob(processedCollage.value.blob, fileName)
}

// 监听设置变化，自动更新预览
watch([layoutSettings, selectedImages], () => {
  if (selectedImages.value.length > 0) {
    generatePreview()
  }
}, { deep: true })
</script>

<style scoped lang="scss">
.image-collage {
  padding: 40px 20px;
}





.main-content {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 30px;
  min-height: calc(100vh - 240px);
  align-items: start;
}

.control-panel {
  height: 100%;
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

.selected-images {
  margin-top: 20px;
  
  h4 {
    margin-bottom: 16px;
    color: white;
    font-weight: 600;
  }
}

.image-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.image-item {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  cursor: move;
  transition: all 0.3s ease;
  border: 2px solid rgba(255, 255, 255, 0.2);
  
  &:hover {
    transform: scale(1.05);
    border-color: rgba(255, 255, 255, 0.4);
  }
  
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.remove-btn {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #ff4757;
  color: white;
  border: none;
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  
  &:hover {
    background: #ff3838;
    transform: scale(1.1);
  }
}

.drag-handle {
  position: absolute;
  bottom: 2px;
  right: 2px;
  color: white;
  font-size: 12px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
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
  
  input[type="range"] {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.2);
    outline: none;
    -webkit-appearance: none;
    
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
  
  input[type="number"], select, input[type="color"] {
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
  
  input[type="color"] {
    height: 40px;
    padding: 4px;
    cursor: pointer;
  }
}

.custom-size {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.actions {
  display: flex;
  gap: 12px;
  flex-direction: column;
  margin-top: 30px;
}

.btn {
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
  
  &.btn-primary {
    background: #a18875;
    color: white;
    
    &:hover {
      background: #8f765f;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(161, 136, 117, 0.3);
    }
  }
  
  &.btn-secondary {
    background: rgba(255, 255, 255, 0.2);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.3);
    
    &:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: translateY(-1px);
    }
  }
  
  &.btn-small {
    padding: 8px 16px;
    font-size: 12px;
  }
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
  
  h3 {
    color: white;
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 8px 0;
  }
  
  .preview-hint {
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
    margin: 0;
  }
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

.preview-collage-container {
  width: 100%;
  display: flex;
  justify-content: center;
}

.preview-canvas {
  max-width: 100%;
  max-height: 100%;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

@media (max-width: 1000px) {
  .main-content {
    grid-template-columns: 300px 1fr;
  }
}

@media (max-width: 768px) {
  .image-collage {
    padding: 20px 10px;
  }
  
  .main-content {
    grid-template-columns: 1fr;
    gap: 20px;
    min-height: auto;
  }
  
  .control-panel {
    position: static;
    height: auto;
    overflow-y: visible;
  }
  
  .actions {
    flex-direction: row;
  }
  
  .image-list {
    grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
  }
  
  .custom-size {
    grid-template-columns: 1fr;
  }
}
</style> 