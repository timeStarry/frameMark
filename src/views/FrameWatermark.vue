<template>
  <div class="frame-watermark">
    <div class="container">
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
                      @click="applyPreset(preset)"
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

                  <!-- 纯色边框颜色选择 -->
                  <div class="form-group" v-if="frameSettings.type === 'solid'">
                    <label>边框颜色</label>
                    
                    <!-- 莫兰蒂色系推荐 -->
                    <div class="color-palette">
                      <div class="palette-title">莫兰蒂色系推荐</div>
                      <div class="color-grid">
                        <div 
                          v-for="colorItem in morandiColors" 
                          :key="colorItem.name"
                          class="color-option" 
                          :class="{ active: frameSettings.color === colorItem.color }"
                          :style="{ backgroundColor: colorItem.color }"
                          @click="selectMorandiColor(colorItem.color)"
                          :title="colorItem.name"
                        >
                          <span class="color-name">{{ colorItem.name }}</span>
                        </div>
                      </div>
                    </div>
                    
                    <!-- 更多颜色选项 -->
                    <div class="more-colors">
                      <button @click="toggleMoreColors" class="more-colors-btn">
                        {{ frameSettings.showMoreColors ? '收起' : '更多颜色' }}
                        <span class="toggle-arrow" :class="{ expanded: frameSettings.showMoreColors }">▼</span>
                      </button>
                      <div v-show="frameSettings.showMoreColors" class="custom-color-input">
                        <input type="color" v-model="frameSettings.color" class="color-picker">
                        <span class="color-value">{{ frameSettings.color }}</span>
                      </div>
                    </div>
                  </div>

                  <!-- 渐变边框颜色选择 -->
                  <div class="form-group" v-if="frameSettings.type === 'gradient'">
                    <label>渐变颜色</label>
                    
                    <!-- 渐变色组合推荐 -->
                    <div class="gradient-palette">
                      <div class="palette-title">优雅渐变推荐</div>
                      <div class="gradient-grid">
                        <div 
                          v-for="gradientItem in gradientCombos" 
                          :key="gradientItem.name"
                          class="gradient-option"
                          :class="{ 
                            active: frameSettings.gradientColor1 === gradientItem.colors[0] && 
                                    frameSettings.gradientColor2 === gradientItem.colors[1] 
                          }"
                          :style="{ 
                            background: `linear-gradient(135deg, ${gradientItem.colors[0]}, ${gradientItem.colors[1]})` 
                          }"
                          @click="selectGradientCombo(gradientItem.colors)"
                          :title="gradientItem.name"
                        >
                          <span class="gradient-name">{{ gradientItem.name }}</span>
                        </div>
                      </div>
                    </div>
                    
                    <!-- 自定义渐变颜色 -->
                    <div class="more-colors">
                      <button @click="toggleMoreColors" class="more-colors-btn">
                        {{ frameSettings.showMoreColors ? '收起' : '自定义渐变' }}
                        <span class="toggle-arrow" :class="{ expanded: frameSettings.showMoreColors }">▼</span>
                      </button>
                      <div v-show="frameSettings.showMoreColors" class="gradient-custom">
                        <div class="gradient-color-row">
                          <label>起始色</label>
                          <input type="color" v-model="frameSettings.gradientColor1" class="color-picker">
                          <span class="color-value">{{ frameSettings.gradientColor1 }}</span>
                        </div>
                        <div class="gradient-color-row">
                          <label>结束色</label>
                          <input type="color" v-model="frameSettings.gradientColor2" class="color-picker">
                          <span class="color-value">{{ frameSettings.gradientColor2 }}</span>
                        </div>
                      </div>
                    </div>
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
                    <div class="font-selector" :class="{ disabled: !fontsLoaded }">
                      <div class="font-selector-current" :class="{ open: showFontDropdown.watermark }" @click="toggleFontDropdown('watermark')" :disabled="!fontsLoaded">
                        <span class="font-display" :style="{ fontFamily: watermarkSettings.fontFamily }">
                          {{ getFontDisplayName(watermarkSettings.fontFamily) }}
                        </span>
                        <span class="dropdown-arrow">▼</span>
                      </div>
                      <div v-if="showFontDropdown.watermark" class="font-dropdown">
                        <template v-for="(category, key) in availableFonts" :key="key">
                          <div v-if="category.fonts.length > 0" class="font-category">
                            <div class="font-category-header">{{ category.name }}</div>
                            <div 
                              v-for="font in category.fonts" 
                              :key="font"
                              class="font-option"
                              :class="{ active: watermarkSettings.fontFamily === font }"
                              @click="selectFont('watermark', font)"
                              :style="{ fontFamily: font }"
                            >
                              {{ getFontDisplayName(font) }}
                            </div>
                          </div>
                        </template>
                        <!-- 备用选项 -->
                        <div v-if="Object.keys(availableFonts).length === 0" class="font-category">
                          <div class="font-category-header">系统默认</div>
                          <div class="font-option" @click="selectFont('watermark', 'Arial')" style="font-family: Arial;">Arial</div>
                          <div class="font-option" @click="selectFont('watermark', 'sans-serif')" style="font-family: sans-serif;">Sans Serif</div>
                        </div>
                      </div>
                    </div>
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
                    <div v-if="frameSettings.type !== 'bottom-bar'" class="position-grid">
                      <div 
                        v-for="position in positionOptions" 
                        :key="position.value"
                        class="position-cell"
                        :class="{ active: watermarkSettings.position === position.value }"
                        @click="watermarkSettings.position = position.value"
                        :title="position.label"
                      >
                        <div class="position-dot"></div>
                      </div>
                    </div>
                    <select v-model="watermarkSettings.bottomBarPosition" v-else>
                      <option value="left">条幅左侧</option>
                      <option value="center">条幅中心</option>
                      <option value="right">条幅右侧</option>
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
                    <label>EXIF 数据字体 
                      <span v-if="!fontsLoaded" class="font-loading">检测中...</span>
                      <span v-else class="font-count">(4 个可用)</span>
                    </label>
                    <div class="font-selector" :class="{ disabled: !fontsLoaded }">
                      <div class="font-selector-current" :class="{ open: showFontDropdown.exif }" @click="toggleFontDropdown('exif')" :disabled="!fontsLoaded">
                        <span class="font-display" :style="{ fontFamily: exifSettings.fontFamily === 'follow-text' ? watermarkSettings.fontFamily : exifSettings.fontFamily }">
                          {{ exifSettings.fontFamily === 'follow-text' ? '跟随文本字体' : getFontDisplayName(exifSettings.fontFamily) }}
                        </span>
                        <span class="dropdown-arrow">▼</span>
                      </div>
                      <div v-if="showFontDropdown.exif" class="font-dropdown">
                        <div class="font-category">
                          <div class="font-category-header">EXIF 字体选择</div>
                          <div 
                            class="font-option"
                            :class="{ active: exifSettings.fontFamily === 'follow-text' }"
                            @click="selectFont('exif', 'follow-text')"
                            :style="{ fontFamily: watermarkSettings.fontFamily }"
                          >
                            跟随文本字体
                          </div>
                          <div 
                            class="font-option"
                            :class="{ active: exifSettings.fontFamily === 'Comfortaa' }"
                            @click="selectFont('exif', 'Comfortaa')"
                            style="font-family: Comfortaa;"
                          >
                            Comfortaa
                          </div>
                          <div 
                            class="font-option"
                            :class="{ active: exifSettings.fontFamily === 'Times New Roman' }"
                            @click="selectFont('exif', 'Times New Roman')"
                            style="font-family: 'Times New Roman';"
                          >
                            Times New Roman
                          </div>
                          <div 
                            class="font-option"
                            :class="{ active: exifSettings.fontFamily === 'Inter' }"
                            @click="selectFont('exif', 'Inter')"
                            style="font-family: Inter;"
                          >
                            Inter
                         </div>
                          <div 
                            class="font-option"
                            :class="{ active: exifSettings.fontFamily === 'Cormorant Garamond' }"
                            @click="selectFont('exif', 'Cormorant Garamond')"
                            style="font-family: 'Cormorant Garamond';"
                          >
                            Cormorant Garamond
                         </div>
                        </div>
                      </div>
                    </div>
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
                    <div v-if="frameSettings.type !== 'bottom-bar'" class="position-grid">
                      <div 
                        v-for="position in positionOptions" 
                        :key="position.value"
                        class="position-cell"
                        :class="{ active: exifSettings.position === position.value }"
                        @click="exifSettings.position = position.value"
                        :title="position.label"
                      >
                        <div class="position-dot"></div>
                      </div>
                    </div>
                    <select v-model="exifSettings.bottomBarPosition" v-else>
                      <option value="left">条幅左侧</option>
                      <option value="center">条幅中心</option>
                      <option value="right">条幅右侧</option>
                    </select>
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
  </div>

  <!-- 导出对话框 -->
  <div v-if="showExportDialog" class="export-dialog-overlay" @click="closeExportDialog">
    <div class="export-dialog" @click.stop>
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
import { ref, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue'
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

// 导出对话框相关
const showExportDialog = ref(false)
const exportedImage = ref(null)

// 预览控制
const zoomLevel = ref(1)
const panX = ref(0)
const panY = ref(0)
const isDragging = ref(false)
const lastMousePos = ref({ x: 0, y: 0 })

// 折叠状态 - 预设默认展开，图片选择展开，其他折叠
const sectionsOpen = reactive({
  upload: true,
  presets: true,
  frame: false,
  watermark: false,
  exif: false
})

// 自定义文件名
const customFileName = ref('')

// 莫兰蒂色系推荐
const morandiColors = [
  { name: '雾霾蓝', color: '#92A5CF' },
  { name: '豆沙绿', color: '#B7C4CF' },
  { name: '暖米灰', color: '#D6C5B9' },
  { name: '玫瑰灰', color: '#C8A2C8' },
  { name: '烟粉色', color: '#E6D2D2' },
  { name: '薄荷绿', color: '#ACCFCC' },
  { name: '奶茶色', color: '#D4C0A1' }
]

// 优雅渐变色组合推荐
const gradientCombos = [
  { name: '日落黄昏', colors: ['#FFB347', '#FF8C94'] },
  { name: '海洋蓝调', colors: ['#92A5CF', '#6FB3D2'] },
  { name: '森林薄雾', colors: ['#ACCFCC', '#B7C4CF'] },
  { name: '玫瑰晨曦', colors: ['#E6D2D2', '#C8A2C8'] },
  { name: '奶茶拿铁', colors: ['#D4C0A1', '#D6C5B9'] },
  { name: '梦幻紫调', colors: ['#C8A2C8', '#B19CD9'] },
  { name: '温柔米色', colors: ['#F5E6D3', '#E8D5C4'] }
]

// 边框设置 - 使用百分比
const frameSettings = reactive({
  type: 'blur',
  widthPercent: 8, // 8% of image size
  borderRadiusPercent: 1.5, // 1.5% of image size
  color: '#ffffff',
  gradientColor1: '#FFB347', // 渐变起始色
  gradientColor2: '#FF8C94', // 渐变结束色
  blurIntensity: 35, // 强烈毛玻璃效果作为默认
  showMoreColors: false // 控制是否显示更多颜色选项
})

// 水印设置 - 使用百分比
const watermarkSettings = reactive({
  text: 'Photographer',
  fontFamily: 'Dancing Script', // 优雅的签名体
  fontSizePercent: 2.5, // 2.5% of image height
  color: '#ffffff',
  opacity: 0.9,
  position: 'bottom-center', // 九格位置默认为下部居中
  bottomBarPosition: 'left' // 底边条幅中的位置 - 水印在左侧
})

// EXIF字体设置
const exifSettings = reactive({
  fontFamily: 'follow-text', // 默认跟随文本字体
  fontSizePercent: 2.0, // EXIF字体大小，稍小于主文字
  position: 'bottom-center', // 九格位置，默认底部居中
  bottomBarPosition: 'right' // 底边条幅中的位置 - EXIF在右侧
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
  DateTime: '📅日期',
  Time: '🕐时间',
  Flash: '闪光灯',
  WhiteBalance: '白平衡'
}

// 默认选中的EXIF字段
const defaultExifFields = ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']

// 九宫格位置选项
const positionOptions = [
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

// 预设样式配置
const presets = [
  {
    id: 'blur-classic',
    name: '经典毛玻璃',
    description: '强烈毛玻璃，优雅签名',
    icon: '🌫️',
    config: {
      frame: {
        type: 'blur',
        widthPercent: 10,
        borderRadiusPercent: 3,
        blurIntensity: 42
      },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 3,
        color: '#ffffff',
        opacity: 1,
        position: 'bottom-center'
      },
      exif: {
        fontFamily: 'Inter',
        fontSizePercent: 2.2,
        position: 'bottom-center',
        fields: ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']
      }
    }
  },
  {
    id: 'solid-clean',
    name: '简约纯色',
    description: '清晰边框，经典布局',
    icon: '⬜',
    config: {
      frame: {
        type: 'solid',
        widthPercent: 15,
        borderRadiusPercent: 0,
        color: '#ffffff'
      },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 3,
        color: '#000000',
        opacity: 1,
        position: 'bottom-center'
      },
      exif: {
        fontFamily: 'Comfortaa',
        fontSizePercent: 2.2,
        position: 'bottom-center',
        fields: ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']
      }
    }
  },
  {
    id: 'gradient-warm',
    name: '暖调渐变',
    description: '奶茶色调，温暖质感',
    icon: '🎨',
    config: {
      frame: {
        type: 'gradient',
        widthPercent: 15,
        borderRadiusPercent: 0,
        gradientColor1: '#D4C0A1',
        gradientColor2: '#D6C5B9'
      },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 5,
        color: '#ffffff',
        opacity: 1,
        position: 'top-center'
      },
      exif: {
        fontFamily: 'Cormorant Garamond',
        fontSizePercent: 3.4,
        position: 'bottom-center',
        fields: ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']
      }
    }
  },
  {
    id: 'bottom-bar-minimal',
    name: '底部条幅',
    description: '简洁条幅，时间标记',
    icon: '📏',
          config: {
        frame: {
          type: 'bottom-bar',
          widthPercent: 0
        },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 3,
        color: '#333333',
        opacity: 1,
        bottomBarPosition: 'left'
      },
      exif: {
        fontFamily: 'Inter',
        fontSizePercent: 2.2,
        bottomBarPosition: 'right',
        fields: ['DateTime', 'Time']
      }
    }
  }
]

// 字体加载状态
const fontsLoaded = ref(false)
const availableFonts = ref({})

// 字体选择器下拉状态
const showFontDropdown = reactive({
  watermark: false,
  exif: false
})

// 字体显示名称映射
const fontDisplayNames = {
  'ZCOOL XiaoWei': '站酷小薇',
  'Ma Shan Zheng': '马善政毛笔楷书',
  'Liu Jian Mao Cao': '钟齐流江毛笔草'
}

// 获取字体显示名称
const getFontDisplayName = (fontName) => {
  return fontDisplayNames[fontName] || fontName
}

// 完整字体库定义
const fontLibrary = {
  signature: {
    name: '签名艺术体',
    fonts: [
      'Dancing Script', 'Pacifico', 'Kaushan Script', 'Great Vibes', 'Allura'
    ]
  },
  chinese: {
    name: '中文书法体',
    fonts: [
      'ZCOOL XiaoWei', 'Ma Shan Zheng', 'Liu Jian Mao Cao'
    ]
  },
  modern: {
    name: '现代艺术体',
    fonts: [
      'Lobster', 'Fredoka One', 'Comfortaa', 'Righteous', 'Bungee'
    ]
  },
  serif: {
    name: '优雅衬线体',
    fonts: [
      'Playfair Display', 'Cormorant Garamond', 'Crimson Text', 'Lora', 'Merriweather'
    ]
  },
  sansSerif: {
    name: '现代简约体',
    fonts: [
      'Inter', 'Source Sans Pro', 'Open Sans'
    ]
  },
  monospace: {
    name: '专业等宽体',
    fonts: [
      'JetBrains Mono', 'Source Code Pro', 'Roboto Mono'
    ]
  },
  system: {
    name: '系统字体',
    fonts: [
      '微软雅黑', 'Arial', 'Times New Roman', 'Helvetica', 'Georgia', 'Verdana'
    ]
  }
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
    
    // 检查当前选择的字体是否可用，如果不可用则切换到可用的字体
    const allAvailableFonts = Object.values(detected).flatMap(category => category.fonts)
    
    if (!allAvailableFonts.includes(watermarkSettings.fontFamily)) {
      // 优先选择签名艺术体，其次选择第一个可用字体
      if (detected.signature?.fonts.length > 0) {
        watermarkSettings.fontFamily = detected.signature.fonts[0]
      } else if (allAvailableFonts.length > 0) {
        watermarkSettings.fontFamily = allAvailableFonts[0]
      }
    }
    
    // EXIF字体检查，如果不是follow-text且不可用，则重置为follow-text
    if (exifSettings.fontFamily !== 'follow-text' && !allAvailableFonts.includes(exifSettings.fontFamily)) {
      exifSettings.fontFamily = 'follow-text'
    }
    
    fontsLoaded.value = true
    
    console.log('字体检测完成:', {
      总分类数: Object.keys(detected).length,
      可用字体数: allAvailableFonts.length,
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

// 安全的预览生成函数
const generatePreviewSafely = async () => {
  if (!selectedImage.value || !previewCanvas.value) return
  
  // 确保字体已加载
  await checkFontsLoaded()
  
  // 添加小延迟确保字体完全可用
  await new Promise(resolve => setTimeout(resolve, 100))
  
  generatePreview()
}

// 方法
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

// 获取实际的EXIF字体
const getActualExifFont = () => {
  return exifSettings.fontFamily === 'follow-text' 
    ? watermarkSettings.fontFamily 
    : exifSettings.fontFamily
}

// 选择字体
const selectFont = (type, fontName) => {
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

// 格式化文件大小
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 获取默认文件名
const getDefaultFileName = () => {
  if (!selectedImage.value) return 'image_watermarked'
  const name = selectedImage.value.name.split('.')[0]
  return `${name}_watermarked`
}

// 应用预设配置
const applyPreset = async (preset) => {
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
  await generatePreviewSafely()
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

const refreshPreview = async () => {
  if (!selectedImage.value) return
  
  console.log('开始刷新预览...')
  
  // 强制重新加载Google Fonts
  await loadGoogleFonts()
  
  // 等待字体渲染完成
  await document.fonts.ready
  
  // 特别处理中文字体，确保完全加载
  const chineseFonts = ['ZCOOL XiaoWei', 'Ma Shan Zheng', 'Liu Jian Mao Cao']
  for (const font of chineseFonts) {
    try {
      await document.fonts.load(`16px "${font}"`)
    } catch (error) {
      console.warn(`字体加载失败: ${font}`, error)
    }
  }
  
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
    // 重置所有设置到默认值
    frameSettings.type = 'blur'
    frameSettings.widthPercent = 8
    frameSettings.borderRadiusPercent = 1.5
    frameSettings.color = '#ffffff'
    frameSettings.gradientColor1 = '#FFB347'
    frameSettings.gradientColor2 = '#FF8C94'
    frameSettings.blurIntensity = 35 // 强烈毛玻璃效果作为默认
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
    
    // 重置自定义文件名
    customFileName.value = ''
    
    sectionsOpen.upload = true
    sectionsOpen.presets = true
    sectionsOpen.frame = false
    sectionsOpen.watermark = false
    sectionsOpen.exif = false
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
  processedImage.value = null
  exifData.value = null
  availableExifData.value = {}
  selectedExifFields.value = []
  customFileName.value = '' // 清空自定义文件名
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

  // 底边条幅特殊处理
  if (frameSettings.type === 'bottom-bar') {
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
    drawBottomBarContent(ctx, scaledTotalWidth, scaledImageHeight + scaledBorderWidth, scaledBarHeight, originalWidth, originalHeight, scale)
    
    ctx.restore()
    return
  }

  // 其他边框类型的原有逻辑
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
    // 模糊边框：边框区域保持直角，只有图片区域有圆角，与其他边框类型保持一致
    // 绘制模糊背景
    drawBlurFrame(ctx, totalWidth, totalHeight, scaledFrameWidth, img, scaledImageWidth, scaledImageHeight)
    
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
    drawWatermark(ctx, totalWidth, totalHeight, scaledFrameWidth, originalWidth, originalHeight, scale)
  } else {
    // 其他边框类型：边框区域保持直角，只有图片区域有圆角
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
    drawWatermark(ctx, totalWidth, totalHeight, scaledFrameWidth, originalWidth, originalHeight, scale)
  }
  
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

const drawBottomBarContent = (ctx, barWidth, imageHeight, barHeight, originalWidth, originalHeight, scale) => {
  if (!watermarkSettings.text && selectedExifFields.value.length === 0) return

  // 设置透明度
  ctx.globalAlpha = watermarkSettings.opacity
  
  // 计算条幅内的边距
  const padding = barHeight * 0.15
  
  // 准备水印文本信息
  let watermarkInfo = null
  if (watermarkSettings.text) {
    // 允许更大的字体大小，最大为条幅高度的60%或用户设置值，取较小者
    const fontSize = Math.min(barHeight * 0.6, originalHeight * (watermarkSettings.fontSizePercent / 100) * scale)
    watermarkInfo = {
      text: watermarkSettings.text,
      font: `${fontSize}px ${watermarkSettings.fontFamily}`,
      color: '#333333', // 底边条幅使用深色文字
      fontSize: fontSize
    }
  }
  
  // 准备EXIF文本信息
  let exifInfo = null
  const exifValues = selectedExifFields.value
    .map(field => availableExifData.value[field])
    .filter(Boolean)
  
  if (exifValues.length > 0) {
    // 允许更大的字体大小，最大为条幅高度的50%或用户设置值，取较小者
    const fontSize = Math.min(barHeight * 0.5, originalHeight * (exifSettings.fontSizePercent / 100) * scale)
    exifInfo = {
      text: exifValues.join('  '),
      font: `${fontSize}px ${getActualExifFont()}`,
      color: '#666666', // 底边条幅EXIF使用稍浅的深色文字
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

const drawWatermark = (ctx, totalWidth, totalHeight, frameWidth, originalWidth, originalHeight, scale) => {
  if (!watermarkSettings.text && selectedExifFields.value.length === 0) return

  // 设置透明度
  ctx.globalAlpha = watermarkSettings.opacity
  
  // 计算边距和区域
  const padding = frameWidth * 0.3
  const imageAreaWidth = totalWidth - frameWidth * 2
  const imageAreaHeight = totalHeight - frameWidth * 2
  
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
  const exifValues = selectedExifFields.value
    .map(field => availableExifData.value[field])
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
    
    // 如果在同一位置，水印需要为EXIF让出空间（水印在上）
    if (samePosition) {
      if (watermarkSettings.position.startsWith('top-')) {
        // 顶部位置：水印保持原位，EXIF向上偏移
        adjustedY = coords.y
      } else if (watermarkSettings.position.startsWith('bottom-')) {
        // 底部位置：水印向上偏移，为EXIF让出下方空间
        adjustedY = coords.y - spacing
      } else { // middle
        // 中部位置：水印向上偏移一半
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
        // 顶部位置：EXIF向上偏移（由于都用bottom基线，向上偏移实际是在水印下方）
        adjustedY = coords.y - spacing
      } else if (exifSettings.position.startsWith('bottom-')) {
        // 底部位置：EXIF保持原位（在下方）
        adjustedY = coords.y
      } else { // middle
        // 中部位置：EXIF向下偏移一半
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
            // 底边条幅：原图尺寸加上条幅高度和三边边框
            const barHeight = img.height * 0.12
            const threeSideBorderWidth = Math.min(img.width, img.height) * (frameSettings.widthPercent / 100)
            canvas.width = img.width + threeSideBorderWidth * 2
            canvas.height = img.height + barHeight + threeSideBorderWidth
          } else {
            // 其他边框类型：使用原始图片尺寸加上边框
            const frameWidth = Math.min(img.width, img.height) * (frameSettings.widthPercent / 100)
            canvas.width = img.width + frameWidth * 2
            canvas.height = img.height + frameWidth * 2
          }

          // 绘制高质量图片 - 使用与预览相同的逻辑
          drawFrame(ctx, canvas.width, canvas.height, img, img.width, img.height)

          // 转换为blob并存储，不直接下载
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

// 关闭导出对话框
const closeExportDialog = () => {
  showExportDialog.value = false
  // 清理blob URL
  if (exportedImage.value?.url) {
    URL.revokeObjectURL(exportedImage.value.url)
  }
  exportedImage.value = null
}

// 下载导出的图片
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
    // 切换到底边条幅时，设置边框宽度为0%
    frameSettings.widthPercent = 0
  } else if (oldType === 'bottom-bar') {
    // 从底边条幅切换到其他类型时，设置一个合理的默认值
    frameSettings.widthPercent = 8
  }
})

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

// 组件挂载时检测可用字体
onMounted(async () => {
  // 检测客户端支持的字体
  await detectAvailableFonts()
  
  // 添加点击外部区域的事件监听器
  document.addEventListener('click', handleClickOutside)
})

// 组件卸载时移除事件监听器
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  
  // 清理导出图片的blob URL
  if (exportedImage.value?.url) {
    URL.revokeObjectURL(exportedImage.value.url)
  }
})
</script>

<style scoped>
.frame-watermark {
  padding: 40px 20px;
}

.main-content {
  min-height: calc(100vh - 240px);
  
  &.has-image {
    display: grid;
    grid-template-columns: 360px 1fr;
    gap: 24px;
    align-items: start;
  }
}

/* 欢迎页面布局 */
.welcome-layout {
  max-width: 1000px;
  margin: 0 auto;
}

.upload-section-main {
  text-align: center;
  margin-bottom: 80px;
}

.upload-title {
  font-size: 2rem;
  font-weight: 600;
  color: white;
  margin-bottom: 32px;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.upload-area-main {
  max-width: 600px;
  margin: 0 auto;
  border: 3px dashed rgba(255, 255, 255, 0.4);
  border-radius: 20px;
  padding: 60px 40px;
  cursor: pointer;
  transition: all 0.3s ease;
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px);
  
  &:hover {
    border-color: rgba(255, 255, 255, 0.6);
    background: rgba(255, 255, 255, 0.1);
    transform: translateY(-4px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  }
}

.upload-placeholder-main {
  color: rgba(255, 255, 255, 0.9);
}

.upload-icon-main {
  font-size: 72px;
  margin-bottom: 24px;
  opacity: 0.8;
}

.upload-text {
  font-size: 1.2rem;
  font-weight: 500;
  margin-bottom: 8px;
  color: white;
}

.upload-hint-main {
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.7);
  margin: 0;
}

/* 功能亮点区域 */
.features-highlights {
  text-align: center;
}

.features-title {
  font-size: 2.2rem;
  font-weight: 700;
  color: white;
  margin-bottom: 50px;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 32px;
  max-width: 1000px;
  margin: 0 auto;
}

.feature-highlight {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  padding: 32px 24px;
  text-align: center;
  transition: all 0.3s ease;
  
  &:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.25);
    transform: translateY(-4px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  }
}

.feature-icon {
  font-size: 2.5rem;
  margin-bottom: 20px;
  display: block;
}

.feature-highlight h4 {
  font-size: 1.25rem;
  font-weight: 600;
  color: white;
  margin-bottom: 12px;
}

.feature-highlight p {
  color: rgba(255, 255, 255, 0.8);
  line-height: 1.6;
  font-size: 0.95rem;
  margin: 0;
}

/* 编辑模式布局 */
.edit-layout {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 24px;
  align-items: start;
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

.presets-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 10px;
}

.preset-card {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.3s ease;
  text-align: center;
  
  &:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  }
  
  &:active {
    transform: translateY(0);
  }
}

.preset-preview {
  margin-bottom: 12px;
}

.preset-icon {
  font-size: 24px;
  margin-bottom: 8px;
}

.preset-info {
  h4 {
    color: white;
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
}

/* 文件信息样式 */
.file-info {
  margin-top: 16px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.file-detail {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  
  &:last-child {
    margin-bottom: 0;
  }
}

.file-label {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  font-weight: 500;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

.file-value {
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-weight: 400;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: rgba(0, 0, 0, 0.2);
  padding: 2px 6px;
  border-radius: 4px;
}

/* 操作区域样式 */
.actions-section {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  padding: 20px;
  margin-top: 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
}

.filename-input {
  margin-bottom: 8px;
}

.filename-preview {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  background: rgba(0, 0, 0, 0.2);
  padding: 6px 8px;
  border-radius: 4px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  border: 1px solid rgba(255, 255, 255, 0.1);
  
  &:before {
    content: '预览：';
    color: rgba(255, 255, 255, 0.5);
    font-size: 11px;
  }
}

  .upload-area {
    border: 2px dashed rgba(255, 255, 255, 0.4);
    border-radius: 12px;
    padding: 20px;
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
    position: relative;
    
    label {
      display: block;
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
      
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
      
      .help-icon {
        display: inline-block;
        width: 14px;
        height: 14px;
        margin-left: 6px;
        color: rgba(255, 255, 255, 0.5);
        font-size: 10px;
        cursor: help;
        border-radius: 50%;
        text-align: center;
        line-height: 14px;
        background: transparent;
        transition: all 0.2s ease;
        position: relative;
        
        &:hover {
          color: #a18875;
          background: rgba(161, 136, 117, 0.1);
          transform: scale(1.2);
        }
        
        &:hover .help-tooltip {
          opacity: 1 !important;
          visibility: visible !important;
          transform: translateY(0) !important;
          pointer-events: auto !important;
        }
      }
      
      .corner-tip {
        color: rgba(255, 255, 255, 0.5);
        font-size: 11px;
        font-weight: 400;
        font-style: italic;
      }
    }
    
    .help-tooltip {
      position: absolute;
      bottom: 100%;
      right: -100px;
      transform: translateY(-5px);
      z-index: 99999;
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s ease;
      pointer-events: none;
      
      .tooltip-content {
        background: rgba(26, 22, 18, 0.98);
        border: 1px solid rgba(161, 136, 117, 0.6);
        border-radius: 6px;
        padding: 8px 10px;
        margin-bottom: 5px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(8px);
        width: 220px;
        white-space: normal;
        
        &::after {
          content: '';
          position: absolute;
          top: 100%;
          right: 107px;
          width: 0;
          height: 0;
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-top: 5px solid rgba(161, 136, 117, 0.6);
        }
        
        .tooltip-text {
          color: rgba(255, 255, 255, 0.9);
          font-size: 11px;
          line-height: 1.4;
          
          strong {
            color: #a18875;
            font-weight: 600;
            font-size: 12px;
          }
          
          .tip {
            color: #a18875;
            font-weight: 500;
            font-size: 10px;
            margin-top: 4px;
            display: block;
            padding-top: 4px;
            border-top: 1px solid rgba(161, 136, 117, 0.3);
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
      }
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
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
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
    transition: all 0.3s ease;
    
    &:hover {
      border-color: rgba(255, 255, 255, 0.5);
      background: rgba(255, 255, 255, 0.15);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    
    &:focus {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(161, 136, 117, 0.3);
    }
    
    option {
      background: #4a3f36;
      color: white;
      padding: 8px 12px;
      border: none;
      
      &:hover {
        background: #5d5148;
      }
      
      &:checked {
        background: #a18875;
        color: white;
      }
    }
    
    optgroup {
      background: #3a312a;
      color: #e8ddd4;
      font-weight: 600;
      font-size: 13px;
      padding: 8px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      
      option {
        background: #4a3f36;
        color: #f5f5f5;
        padding-left: 20px;
        font-weight: 400;
        
        &:hover {
          background: #5d5148;
        }
        
        &:checked {
          background: #a18875;
          color: white;
        }
      }
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

/* 字体选择器样式 */
.font-selector {
  position: relative;
  width: 100%;
  
  &.disabled {
    opacity: 0.6;
    pointer-events: none;
  }
}

.font-selector-current {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: space-between;
  
  &:hover {
    border-color: rgba(255, 255, 255, 0.5);
    background: rgba(255, 255, 255, 0.15);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  
  .font-display {
    flex: 1;
    text-align: left;
    font-size: 14px;
    font-weight: 500;
  }
  
  .dropdown-arrow {
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
    transition: transform 0.2s ease;
    margin-left: 8px;
  }
  
  &.open .dropdown-arrow {
    transform: rotate(180deg);
  }
}

.font-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 1000;
  background: rgba(74, 63, 54, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
  max-height: 300px;
  overflow-y: auto;
  margin-top: 4px;
  
  &::-webkit-scrollbar {
    width: 6px;
  }
  
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  
  &::-webkit-scrollbar-thumb {
    background: rgba(161, 136, 117, 0.5);
    border-radius: 3px;
    
    &:hover {
      background: rgba(161, 136, 117, 0.7);
    }
  }
}

.font-category {
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  
  &:last-child {
    border-bottom: none;
  }
}

.font-category-header {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  position: sticky;
  top: 0;
  z-index: 1;
}

.font-option {
  padding: 10px 12px;
  color: white;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  
  &:last-child {
    border-bottom: none;
  }
  
  &:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #a18875;
  }
  
  &.active {
    background: rgba(161, 136, 117, 0.3);
    color: #a18875;
    font-weight: 600;
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

/* 九宫格位置选择器样式 */
.position-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  width: 120px;
  height: 120px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 8px;
  margin-top: 4px;
}

.position-cell {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  position: relative;
  
  &:hover {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.4);
    transform: scale(1.05);
  }
  
  &.active {
    background: #a18875;
    border-color: #a18875;
    box-shadow: 0 0 8px rgba(161, 136, 117, 0.5);
    
    .position-dot {
      background: white;
      transform: scale(1.2);
    }
  }
}

.position-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.6);
  transition: all 0.3s ease;
}

.actions {
  display: flex;
  gap: 12px;
  flex-direction: column;
  margin-top: 16px;
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
}

@media (max-width: 1000px) {
  .main-content.has-image {
    grid-template-columns: 300px 1fr;
  }
  
  .upload-area-main {
    padding: 40px 30px;
  }
  
  .features-grid {
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 24px;
  }
}

@media (max-width: 768px) {
  .main-content.has-image {
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
  
  /* 移动端欢迎布局样式 */
  .upload-title {
    font-size: 1.6rem;
  }
  
  .upload-area-main {
    padding: 40px 20px;
    border-width: 2px;
  }
  
  .upload-icon-main {
    font-size: 56px;
  }
  
  .upload-text {
    font-size: 1.1rem;
  }
  
  .features-title {
    font-size: 1.8rem;
    margin-bottom: 40px;
  }
  
  .features-grid {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  
  .feature-highlight {
    padding: 24px 20px;
  }
  
  /* 移动端导出对话框样式 */
  .export-dialog {
    width: 95%;
    max-width: none;
    margin: 20px;
    max-height: 80vh;
  }
  
  .dialog-header {
    padding: 16px 20px;
    
    h3 {
      font-size: 16px;
    }
  }
  
  .dialog-content {
    padding: 20px;
  }
  
  .export-preview {
    aspect-ratio: 4/3;
    padding: 12px;
  }
  
  .export-info {
    .export-filename {
      font-size: 14px;
    }
    
    .export-size {
      font-size: 12px;
    }
    
    .export-resolution {
      font-size: 12px;
    }
  }
  
  .dialog-actions {
    padding: 0 20px 20px;
    gap: 12px;
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

/* 导出对话框样式 */
.export-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.export-dialog {
  background: #a18875;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 20px;
  padding: 0;
  width: 90%;
  max-width: 600px;
  max-height: 90vh;
  overflow: hidden;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  position: relative;
}

.dialog-header {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px);
  padding: 20px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
  text-align: center;
  
  h3 {
    color: white;
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }
}



.dialog-content {
  padding: 24px;
  text-align: center;
}

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

.dialog-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 0 24px 24px;
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

/* 颜色选择器相关样式 */
.color-palette, .gradient-palette {
  margin-top: 12px;
  
  .palette-title {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 8px;
    font-weight: 500;
  }
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.color-option {
  position: relative;
  height: 36px;
  border-radius: 8px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.3);
  }
  
  &.active {
    border-color: #a18875;
    box-shadow: 0 0 0 1px #a18875, 0 4px 12px rgba(161, 136, 117, 0.4);
    transform: translateY(-1px);
  }
  
  .color-name {
    font-size: 10px;
    color: rgba(0, 0, 0, 0.8);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
    text-align: center;
    padding: 2px 4px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.9);
    backdrop-filter: blur(4px);
  }
}

.gradient-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.gradient-option {
  position: relative;
  height: 40px;
  border-radius: 8px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.3);
  }
  
  &.active {
    border-color: #a18875;
    box-shadow: 0 0 0 1px #a18875, 0 4px 12px rgba(161, 136, 117, 0.4);
    transform: translateY(-1px);
  }
  
  .gradient-name {
    font-size: 11px;
    color: rgba(0, 0, 0, 0.8);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
    text-align: center;
    padding: 3px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(4px);
  }
}

.more-colors {
  margin-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-top: 12px;
}

.more-colors-btn {
  width: 100%;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 8px 12px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: space-between;
  
  &:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
  }
  
  .toggle-arrow {
    transition: transform 0.3s ease;
    font-size: 10px;
    
    &.expanded {
      transform: rotate(180deg);
    }
  }
}

.custom-color-input {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  
  .color-picker {
    width: 40px;
    height: 30px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    background: none;
    
    &::-webkit-color-swatch {
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 4px;
    }
  }
  
  .color-value {
    font-family: monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    background: rgba(0, 0, 0, 0.3);
    padding: 4px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
}

.gradient-custom {
  margin-top: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gradient-color-row {
  display: flex;
  align-items: center;
  gap: 8px;
  
  label {
    min-width: 50px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.8);
    margin: 0;
  }
  
  .color-picker {
    width: 40px;
    height: 28px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    background: none;
    
    &::-webkit-color-swatch {
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 4px;
    }
  }
  
  .color-value {
    flex: 1;
    font-family: monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    background: rgba(0, 0, 0, 0.3);
    padding: 4px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
}
</style> 