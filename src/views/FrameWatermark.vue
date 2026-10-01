<template>
  <div class="frame-watermark tool-workspace">
    <div class="container">
      <nav class="tool-subnav" aria-label="工具导航"><router-link to="/tools">工具箱</router-link><span aria-hidden="true">/</span><span>边框水印</span></nav>
      <h1 class="page-title">边框水印工具</h1>
      
      <div class="main-content" :class="{ 'has-image': selectedImage }">
        <!-- 未选择图片时的布局 -->
        <div v-if="!selectedImage" class="welcome-layout">
          <!-- 图片上传区域 -->
          <div class="upload-section-main">
            <div class="upload-area-main" @click="triggerFileInput">
              <input 
                ref="fileInput" 
                type="file" 
                accept="image/*" 
                @change="handleImageUpload"
                style="display: none;"
              >
              <div class="upload-placeholder-main">
                <div class="upload-icon-main">📁</div>
                <p class="upload-text">点击选择图片或拖拽图片到此处</p>
                <p class="upload-hint-main">支持 JPG、PNG、WEBP 格式</p>
              </div>
            </div>
          </div>

          <!-- 功能亮点 -->
          <div class="features-highlights">
            <h2 class="features-title">边框水印亮点</h2>
            <div class="features-grid">
              <div class="feature-highlight">
                <div class="feature-icon">🌫️</div>
                <h4>多样边框效果</h4>
                <p>模糊、纯色、渐变、底部条幅四种边框样式</p>
              </div>
              
              <div class="feature-highlight">
                <div class="feature-icon">✍️</div>
                <h4>个性水印设置</h4>
                <p>自定义文字内容、字体样式、位置大小</p>
              </div>
              
              <div class="feature-highlight">
                <div class="feature-icon">📸</div>
                <h4>EXIF信息展示</h4>
                <p>自动读取并显示拍摄参数，可自定义EXIF字段</p>
              </div>
              
              <div class="feature-highlight">
                <div class="feature-icon">🛒</div>
                <h4>预设样式快选</h4>
                <p>四类预设样式，一键应用</p>
              </div>
              
              <div class="feature-highlight">
                <div class="feature-icon">🎨</div>
                <h4>莫兰迪色系</h4>
                <p>莫兰迪色系预设，快速定义边框颜色</p>
              </div>
              
              <div class="feature-highlight">
               <div class="feature-icon">🔤</div>
                <h4>Google fonts</h4>
                <p>集成Google在线字体库，无版权风险</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 已选择图片时的布局 -->
        <div v-else class="edit-layout">
          <!-- 左侧控制面板 -->
          <div class="control-panel">
            <div class="control-card">
              <!-- 预设样式 -->
              <div class="settings-section" v-if="selectedImage">
                <div class="section-header" @click="toggleSection('presets')">
                  <h3>预设样式</h3>
                  <span class="toggle-icon" :class="{ collapsed: !sectionsOpen.presets }">▼</span>
                </div>
                
                <div v-show="sectionsOpen.presets" class="section-content">
                  <div class="presets-grid">
                    <div 
                      v-for="preset in presets" 
                      :key="preset.id"
                      class="preset-card"
                      @click="handleApplyPreset(preset)"
                    >
                      <div class="preset-preview">
                        <div class="preset-icon">{{ preset.icon }}</div>
                      </div>
                      <div class="preset-info">
                        <h4>{{ preset.name }}</h4>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 图片选择 -->
              <div class="settings-section">
                <div class="section-header" @click="toggleSection('upload')">
                  <h3>图片选择</h3>
                  <span class="toggle-icon" :class="{ collapsed: !sectionsOpen.upload }">▼</span>
                </div>
                
                <div v-show="sectionsOpen.upload" class="section-content">
                  <div class="upload-area" @click="triggerFileInput">
                    <div class="uploaded-image">
                      <img :src="selectedImage.preview" alt="已选择的图片">
                      <button @click.stop="removeImage" class="remove-btn">✕</button>
                    </div>
                  </div>
                  
                  <!-- 文件信息显示 -->
                  <div class="file-info">
                    <div class="file-detail">
                      <span class="file-label">文件名：</span>
                      <span class="file-value">{{ selectedImage.name }}</span>
                    </div>
                    <div class="file-detail">
                      <span class="file-label">文件大小：</span>
                      <span class="file-value">{{ formatFileSize(selectedImage.file.size) }}</span>
                    </div>
                    <div class="file-detail">
                      <span class="file-label">文件类型：</span>
                      <span class="file-value">{{ selectedImage.file.type }}</span>
                    </div>
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
                      <option value="bottom-bar">底边条幅</option>
                    </select>
                  </div>

                  <div class="form-group">
                    <label v-if="frameSettings.type !== 'bottom-bar'">边框宽度: {{ frameSettings.widthPercent }}%</label>
                    <label v-else>三边边框: {{ frameSettings.widthPercent }}%
                      <span class="corner-tip">除底边外的上、左、右边框</span>
                    </label>
                    <input 
                      type="range" 
                      v-model="frameSettings.widthPercent" 
                      :min="frameSettings.type === 'bottom-bar' ? '0' : '3'" 
                      :max="frameSettings.type === 'bottom-bar' ? '5' : '15'" 
                      :step="frameSettings.type === 'bottom-bar' ? '0.2' : '0.5'"
                    >
                  </div>

                  <div class="form-group" v-if="frameSettings.type !== 'bottom-bar'">
                    <label>
                      图片圆角: {{ frameSettings.borderRadiusPercent }}%
                      <span class="corner-tip">仅影响图片内容区域</span>
                    </label>
                    <input 
                      type="range" 
                      v-model="frameSettings.borderRadiusPercent" 
                      min="0" 
                      max="5" 
                      step="0.2"
                    >
                  </div>

                  <!-- 边框颜色选择 -->
                  <div class="form-group" v-if="frameSettings.type === 'solid'">
                    <label>边框颜色</label>
                    <ColorSelector
                      type="solid"
                      :selected-color="frameSettings.color"
                      :show-more-colors="frameSettings.showMoreColors"
                      :morandi-colors="morandiColors"
                      :gradient-combos="gradientCombos"
                      @select-color="selectMorandiColor"
                      @toggle-more-colors="toggleMoreColors"
                      @update-color="(color) => frameSettings.color = color"
                    />
                  </div>

                  <!-- 渐变边框颜色选择 -->
                  <div class="form-group" v-if="frameSettings.type === 'gradient'">
                    <label>渐变颜色</label>
                    <ColorSelector
                      type="gradient"
                      :selected-gradient-color1="frameSettings.gradientColor1"
                      :selected-gradient-color2="frameSettings.gradientColor2"
                      :show-more-colors="frameSettings.showMoreColors"
                      :morandi-colors="morandiColors"
                      :gradient-combos="gradientCombos"
                      @select-gradient-combo="selectGradientCombo"
                      @toggle-more-colors="toggleMoreColors"
                      @update-gradient-color1="(color) => frameSettings.gradientColor1 = color"
                      @update-gradient-color2="(color) => frameSettings.gradientColor2 = color"
                    />
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
                    <label>文字字体 
                      <span v-if="!fontsLoaded" class="font-loading">检测中...</span>
                      <span v-else class="font-count">({{ Object.values(availableFonts).reduce((sum, cat) => sum + cat.fonts.length, 0) }} 个可用)</span>
                      <span class="help-icon">ⓘ
                        <div class="help-tooltip">
                          <div class="tooltip-content">
                            <div class="tooltip-text">
                              <strong>字体来源和检测</strong><br>
                              • 系统兜底字体（不在数量统计中）<br>
                              • 30种精选 <a href="https://fonts.google.com" target="_blank" class="google-fonts-link">Google Fonts</a> <br>
                              • 仅显示检测可用的字体<br>
                              <span class="tip">💡 如字体数量较少，请尝试刷新页面</span>
                            </div>
                          </div>
                        </div>
                      </span>
                    </label>
                    <FontSelector
                      type="watermark"
                      :selected-font="watermarkSettings.fontFamily"
                      :available-fonts="availableFonts"
                      :fonts-loaded="fontsLoaded"
                      :is-open="showFontDropdown.watermark"
                      :get-font-display-name="getFontDisplayName"
                      @toggle-dropdown="() => toggleFontDropdown('watermark')"
                      @select-font="(font) => handleSelectFont('watermark', font)"
                    />
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
                    <label>水印位置</label>
                    <PositionSelector
                      :type="frameSettings.type !== 'bottom-bar' ? 'grid' : 'bottom-bar'"
                      :selected-position="frameSettings.type !== 'bottom-bar' ? watermarkSettings.position : watermarkSettings.bottomBarPosition"
                      :position-options="positionOptions"
                      @select-position="(pos) => handleWatermarkPositionChange(pos)"
                    />
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
                    <label>EXIF 数据字体 
                      <span v-if="!fontsLoaded" class="font-loading">检测中...</span>
                      <span v-else class="font-count">(5 个可用)</span>
                    </label>
                    <FontSelector
                      type="exif"
                      :selected-font="exifSettings.fontFamily"
                      :available-fonts="availableFonts"
                      :fonts-loaded="fontsLoaded"
                      :is-open="showFontDropdown.exif"
                      :follow-text-font="watermarkSettings.fontFamily"
                      :get-font-display-name="getFontDisplayName"
                      @toggle-dropdown="() => toggleFontDropdown('exif')"
                      @select-font="(font) => handleSelectFont('exif', font)"
                    />
                  </div>

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

                  <div class="form-group">
                    <label>EXIF位置</label>
                    <PositionSelector
                      :type="frameSettings.type !== 'bottom-bar' ? 'grid' : 'bottom-bar'"
                      :selected-position="frameSettings.type !== 'bottom-bar' ? exifSettings.position : exifSettings.bottomBarPosition"
                      :position-options="positionOptions"
                      @select-position="(pos) => handleExifPositionChange(pos)"
                    />
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

              <!-- 操作区域 -->
              <div class="actions-section" v-if="selectedImage">
                <div class="form-group">
                  <label>输出文件名</label>
                  <input 
                    type="text" 
                    v-model="customFileName" 
                    placeholder="自定义文件名（不含扩展名）"
                    class="filename-input"
                  >
                  <div class="filename-preview">
                    {{ customFileName || getDefaultFileName() }}.png
                  </div>
                </div>
                
                <div class="actions">
                  <button @click="generateAndExport" class="btn btn-primary" :disabled="isProcessing">
                    <span v-if="isProcessing">生成中...</span>
                    <span v-else>生成导出</span>
                  </button>
                  <button @click="resetAll" class="btn btn-outline">
                    重置页面
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 右侧预览区域 -->
          <div class="preview-panel">
            <div class="preview-header">
              <div>
                <h3>预览效果</h3>
                <p class="preview-tip">
                  <strong>预览说明：</strong>为保证实时渲染性能，预览框采用缩放显示（最大800×600），存在分辨率压缩和模糊度偏差。<br>
                  <strong>实际导出：</strong>使用原图完整分辨率，字体清晰锐利，模糊效果准确还原。
                </p>
              </div>
              <div class="preview-controls" v-if="selectedImage">
                <button @click="refreshPreview" class="zoom-btn" title="刷新预览">
                  🔄
                </button>
                <button @click="resetZoom" class="zoom-btn" title="重置缩放">
                  🔍
                </button>
                <span class="zoom-level">{{ Math.round(zoomLevel * 100) }}%</span>
              </div>
            </div>
            
            <div class="preview-viewport" 
                 @wheel="(e) => handleWheel(e, selectedImage)"
                 @mousedown="(e) => startDrag(e, selectedImage)"
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
  </div>

  <!-- 导出对话框 -->
  <div v-if="showExportDialog" class="dialog-overlay" @click="closeExportDialog">
    <div class="dialog" @click.stop>
      <div class="dialog-header">
        <h3>导出完成</h3>
      </div>
      
      <div class="dialog-content">
        <div class="export-preview">
          <img :src="exportedImage?.url" alt="导出图片" class="exported-image">
        </div>
        
        <div class="export-info">
          <p class="export-filename">{{ exportedImage?.filename }}</p>
          <p class="export-size">{{ exportedImage?.size }}</p>
          <p class="export-resolution">{{ exportedImage?.resolution }}</p>
        </div>
      </div>
      
      <div class="dialog-actions">
        <button @click="downloadExportedImage" class="download-btn">
          <div class="download-icon">💾</div>
          <span>下载图片</span>
        </button>
        
        <p class="close-hint">点击框外任意位置关闭对话框</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { extractExifData } from '@/utils/exifUtils'
import { downloadBlob } from '@/utils/fileUtils'

// 导入常量配置
import { presets } from './frame-watermark/constants/presets'
import { positionOptions } from './frame-watermark/constants/positions'

// 导入组合函数
import { useFontManager } from './frame-watermark/composables/useFontManager'
import { useCanvasRenderer } from './frame-watermark/composables/useCanvasRenderer'
import { useExifHandler } from './frame-watermark/composables/useExifHandler'
import { useSettingsManager } from './frame-watermark/composables/useSettingsManager'

// 导入UI组件
import FontSelector from './frame-watermark/components/FontSelector.vue'
import ColorSelector from './frame-watermark/components/ColorSelector.vue'
import PositionSelector from './frame-watermark/components/PositionSelector.vue'

// 使用组合函数
const {
  fontsLoaded,
  availableFonts,
  showFontDropdown,
  getFontDisplayName,
  detectAvailableFonts,
  checkFontsLoaded,
  toggleFontDropdown,
  handleClickOutside
} = useFontManager()

const {
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
} = useCanvasRenderer()

const {
  availableExifData,
  selectedExifFields,
  formatExifDisplay,
  processExifData,
  getActualExifFont,
  resetExifData
} = useExifHandler()

const {
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
  applyPreset,
  resetAllSettings
} = useSettingsManager()

// 响应式数据
const fileInput = ref(null)
const previewCanvas = ref(null)
const selectedImage = ref(null)
const isProcessing = ref(false)

// 导出对话框相关
const showExportDialog = ref(false)
const exportedImage = ref(null)

// 文件处理方法
const triggerFileInput = () => {
  fileInput.value.click()
}

const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const getDefaultFileName = () => {
  if (!selectedImage.value) return 'image_watermarked'
  const name = selectedImage.value.name.split('.')[0]
  return `${name}_watermarked`
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
    processExifData(exif)

    // 等待DOM更新后安全生成预览
    await nextTick()
    await generatePreviewSafely()
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
  resetExifData()
  customFileName.value = ''
}

// 预设和设置处理
const handleApplyPreset = async (preset) => {
  await applyPreset(preset, availableExifData, selectedExifFields, generatePreviewSafely)
}

const handleSelectFont = (type, fontName) => {
  if (type === 'watermark') {
    watermarkSettings.fontFamily = fontName
  } else if (type === 'exif') {
    exifSettings.fontFamily = fontName
  }
  
  // 关闭下拉菜单
  showFontDropdown[type] = false
  
  // 重新生成预览
  generatePreviewSafely()
}

const handleWatermarkPositionChange = (position) => {
  if (frameSettings.type !== 'bottom-bar') {
    watermarkSettings.position = position
  } else {
    watermarkSettings.bottomBarPosition = position
  }
}

const handleExifPositionChange = (position) => {
  if (frameSettings.type !== 'bottom-bar') {
    exifSettings.position = position
  } else {
    exifSettings.bottomBarPosition = position
  }
}

// 预览生成
const generatePreview = () => {
  if (!selectedImage.value || !previewCanvas.value) return

  const canvas = previewCanvas.value
  const ctx = canvas.getContext('2d')
  const img = new Image()

  img.onload = () => {
    // 设置画布尺寸
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

    // 绘制边框和图片
    drawFrame(
      ctx, 
      displayWidth, 
      displayHeight, 
      img, 
      img.width, 
      img.height,
      frameSettings,
      watermarkSettings,
      exifSettings,
      selectedExifFields.value,
      availableExifData.value,
      () => getActualExifFont(exifSettings, watermarkSettings)
    )
  }

  img.src = selectedImage.value.preview
}

const generatePreviewSafely = async () => {
  if (!selectedImage.value || !previewCanvas.value) return
  
  // 确保字体已加载
  await checkFontsLoaded()
  
  // 添加小延迟确保字体完全可用
  await new Promise(resolve => setTimeout(resolve, 100))
  
  generatePreview()
}

const refreshPreview = async () => {
  if (!selectedImage.value) return
  
  console.log('开始刷新预览...')
  
  // 等待字体渲染完成
  await document.fonts.ready
  
  // 清除画布，强制重新绘制
  if (previewCanvas.value) {
    const ctx = previewCanvas.value.getContext('2d')
    ctx.clearRect(0, 0, previewCanvas.value.width, previewCanvas.value.height)
  }
  
  // 延迟一小段时间确保字体完全可用
  await new Promise(resolve => setTimeout(resolve, 300))
  
  // 重新生成预览
  generatePreview()
  
  console.log('预览刷新完成')
}

const resetAll = () => {
  if (confirm('确定要重置所有设置吗？')) {
    removeImage()
    resetZoom()
    resetAllSettings()
  }
}

// 导出处理
const generateAndExport = async () => {
  if (!selectedImage.value || isProcessing.value) return

  isProcessing.value = true
  
  try {
    // 确保字体已加载
    await checkFontsLoaded()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()

    await new Promise((resolve, reject) => {
      img.onload = () => {
        try {
          // 计算画布尺寸
          if (frameSettings.type === 'bottom-bar') {
            const barHeight = img.height * 0.12
            const threeSideBorderWidth = Math.min(img.width, img.height) * (frameSettings.widthPercent / 100)
            canvas.width = img.width + threeSideBorderWidth * 2
            canvas.height = img.height + barHeight + threeSideBorderWidth
          } else {
            const frameWidth = Math.min(img.width, img.height) * (frameSettings.widthPercent / 100)
            canvas.width = img.width + frameWidth * 2
            canvas.height = img.height + frameWidth * 2
          }

          // 绘制高质量图片
          drawFrame(
            ctx,
            canvas.width,
            canvas.height,
            img,
            img.width,
            img.height,
            frameSettings,
            watermarkSettings,
            exifSettings,
            selectedExifFields.value,
            availableExifData.value,
            () => getActualExifFont(exifSettings, watermarkSettings)
          )

          // 转换为blob并存储
          canvas.toBlob((blob) => {
            const fileName = `${customFileName.value || getDefaultFileName()}.png`
            const fileSize = formatFileSize(blob.size)
            const resolution = `${canvas.width} × ${canvas.height} 像素`
            
            // 存储导出图片信息
            exportedImage.value = {
              blob,
              url: URL.createObjectURL(blob),
              filename: fileName,
              size: fileSize,
              resolution: resolution
            }
            
            // 显示导出对话框
            showExportDialog.value = true
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

const closeExportDialog = () => {
  showExportDialog.value = false
  if (exportedImage.value?.url) {
    URL.revokeObjectURL(exportedImage.value.url)
  }
  exportedImage.value = null
}

const downloadExportedImage = () => {
  if (!exportedImage.value) return
  
  downloadBlob(exportedImage.value.blob, exportedImage.value.filename)
  closeExportDialog()
}

// 监听设置变化，自动更新预览
watch([frameSettings, watermarkSettings, exifSettings, selectedExifFields], async () => {
  if (selectedImage.value) {
    await generatePreviewSafely()
  }
}, { deep: true })

// 监听边框类型变化，调整边框宽度默认值
watch(() => frameSettings.type, (newType, oldType) => {
  if (newType === 'bottom-bar') {
    frameSettings.widthPercent = 0
  } else if (oldType === 'bottom-bar') {
    frameSettings.widthPercent = 8
  }
})

// 组件挂载时检测可用字体
onMounted(async () => {
  await detectAvailableFonts()
  document.addEventListener('click', handleClickOutside)
})

// 组件卸载时移除事件监听器
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  
  if (exportedImage.value?.url) {
    URL.revokeObjectURL(exportedImage.value.url)
  }
})
</script>

<style scoped>
/* 边框水印工具特有样式 */
.frame-watermark {
  /* 继承 page-container 的样式 */
}

/* 导出对话框特有样式 */
.export-preview {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
  display: flex;
  justify-content: center;
  align-items: center;
  aspect-ratio: 4/3;
  overflow: hidden;
}

.exported-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.export-info {
  margin-bottom: 20px;
  
  .export-filename {
    color: white;
    font-size: 16px;
    font-weight: 500;
    margin: 0 0 8px 0;
  }
  
  .export-size {
    color: rgba(255, 255, 255, 0.7);
    font-size: 14px;
    margin: 0 0 4px 0;
  }
  
  .export-resolution {
    color: rgba(255, 255, 255, 0.7);
    font-size: 14px;
    margin: 0;
  }
}

.download-btn {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  padding: 16px 32px;
  cursor: pointer;
  transition: all 0.4s ease;
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative;
  overflow: hidden;
  color: white;
  font-size: 16px;
  font-weight: 600;
  min-width: 160px;
  justify-content: center;
  
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
    transition: left 0.6s ease;
  }
  
  &:hover {
    transform: translateY(-4px) scale(1.05);
    background: rgba(255, 255, 255, 0.25);
    border-color: rgba(255, 255, 255, 0.4);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    
    &::before {
      left: 100%;
    }
    
    .download-icon {
      transform: scale(1.1);
    }
  }
  
  &:active {
    transform: translateY(-2px) scale(1.02);
  }
}

.download-icon {
  font-size: 20px;
  transition: transform 0.3s ease;
}

.close-hint {
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  margin: 0;
  text-align: center;
  font-style: italic;
}

/* 边框水印工具特有的字体选择器样式扩展 */
.form-group label {
  .font-loading {
    color: #a18875;
    font-size: 12px;
    font-weight: 400;
    animation: pulse 1.5s ease-in-out infinite;
  }
  
  .font-count {
    color: rgba(255, 255, 255, 0.6);
    font-size: 12px;
    font-weight: 400;
  }
  
  .google-fonts-link {
    color: #a18875;
    text-decoration: none;
    font-weight: 500;
    border-bottom: 1px solid rgba(161, 136, 117, 0.5);
    transition: all 0.2s ease;
    
    &:hover {
      color: #c4a584;
      border-bottom-color: #c4a584;
      text-decoration: none;
    }
  }
}

/* 移动端适配 */
@media (max-width: 768px) {
  .export-preview {
    aspect-ratio: 4/3;
    padding: 12px;
  }
  
  .export-info {
    .export-filename {
      font-size: 14px;
    }
    
    .export-size,
    .export-resolution {
      font-size: 12px;
    }
  }
  
  .download-btn {
    min-width: 140px;
    padding: 14px 24px;
    font-size: 14px;
    
    .download-icon {
      font-size: 18px;
    }
  }
  
  .close-hint {
    font-size: 11px;
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style> 